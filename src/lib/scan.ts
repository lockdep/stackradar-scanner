import * as k8s from "@kubernetes/client-node";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "./logger.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export const API_URL = process.env.STACKRADAR_API_URL?.replace(/\/$/, "");
export const API_KEY = process.env.STACKRADAR_API_KEY;

// Populated by the Helm chart from `.Chart.Version` so the server can record
// which scanner release each cluster is running and surface outdated agents in
// the UI. Blank (`""` / `unknown`) in dev where no chart is in play.
export const SCANNER_VERSION = process.env.STACKRADAR_SCANNER_VERSION?.trim() || "unknown";

export const EXCLUDE_NAMESPACES = new Set(
    (
        process.env.EXCLUDE_NAMESPACES ??
        "kube-system,kube-public,kube-node-lease"
    )
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
);

// `null` means "no allowlist, fall back to EXCLUDE_NAMESPACES". A list that
// parses to nothing (unset, `""`, or `" , "`) has to mean that too: an empty
// allowlist would otherwise match no namespace at all, and the agent would sit
// there scanning nothing while looking perfectly healthy.
const includeNamespaces = (process.env.INCLUDE_NAMESPACES ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

export const INCLUDE_NAMESPACES = includeNamespaces.length > 0
    ? new Set(includeNamespaces)
    : null;

export const SYFT_TIMEOUT_MS = parseInt(process.env.SYFT_TIMEOUT_MS ?? "300000", 10);
export const CLUSTER_NAME = process.env.CLUSTER_NAME?.trim() || undefined;
export const CLUSTER_ID = process.env.STACKRADAR_CLUSTER_ID?.trim() || undefined;
export const CONCURRENT_SCANS = Math.max(1, parseInt(process.env.CONCURRENT_SCANS ?? "5", 10));
export const SKIP_EXISTING_DIGESTS = (process.env.SKIP_EXISTING_DIGESTS ?? "true") !== "false";
export const RESOLVE_IMAGE_PULL_SECRETS = (process.env.RESOLVE_IMAGE_PULL_SECRETS ?? "true") !== "false";

export function validateConfig(): void {
    if (!API_URL || !API_KEY) {
        log.fatal("STACKRADAR_API_URL and STACKRADAR_API_KEY are required");
        process.exit(1);
    }
}

// ─── Cluster access ──────────────────────────────────────────────────────────

// Present only when a service account is mounted, i.e. only inside a pod.
const IN_CLUSTER_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Loads cluster credentials, preferring the in-cluster service account and
 * falling back to the ambient kubeconfig so the agent can be run on a laptop.
 *
 * Which path was taken is logged at startup: a pod that has silently picked up
 * a mounted kubeconfig is talking to a cluster nobody intended, and that should
 * be visible in the first few lines of its log rather than inferred later.
 */
export function loadKubeConfig(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();

    if (fs.existsSync(IN_CLUSTER_TOKEN)) {
        kc.loadFromCluster();
        log.info({ credentials: "in-cluster service account" }, "loaded cluster credentials");
        return kc;
    }

    kc.loadFromDefault();
    log.warn(
        { credentials: "ambient kubeconfig", context: kc.getCurrentContext() },
        "no service account token mounted — falling back to the ambient kubeconfig. " +
        "This is the development path; inside a pod it means the ServiceAccount is missing"
    );
    return kc;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImageInfo {
    pullRef: string;
    displayName: string;
    digest: string | undefined;
    namespace: string;
    workloadName: string;
    containerName: string;
    workloadKind: string;
    podLabels: Record<string, string>;
    podAnnotations: Record<string, string>;
    imagePullSecrets: string[];
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

export class Semaphore {
    private slots: number;
    private queue: (() => void)[] = [];

    constructor(concurrency: number) {
        this.slots = concurrency;
    }

    async acquire(): Promise<void> {
        if (this.slots > 0) { this.slots--; return; }
        return new Promise((resolve) => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) { next(); } else { this.slots++; }
    }
}

// ─── Namespace filtering ─────────────────────────────────────────────────────

export function shouldScan(namespace: string): boolean {
    if (INCLUDE_NAMESPACES) return INCLUDE_NAMESPACES.has(namespace);
    return !EXCLUDE_NAMESPACES.has(namespace);
}

// ─── Pod label / annotation helpers ──────────────────────────────────────────

// Labels we keep so the UI can answer "where did this image come from?".
// Helm sets `helm.sh/chart` and `app.kubernetes.io/managed-by` as labels on
// the rendered pod template (not annotations), so they live here.
//
// This set and the one below are the privacy boundary README.md commits to:
// every pod label and annotation outside them is dropped before anything is
// sent. They are exported so scan.test.ts can snapshot them — widening either
// one is then a visible diff in a test, not an incidental edit.
export const RELEVANT_POD_LABEL_KEYS = new Set([
    "app",
    "version",
    "app.kubernetes.io/name",
    "app.kubernetes.io/version",
    "app.kubernetes.io/component",
    "app.kubernetes.io/part-of",
    "app.kubernetes.io/instance",
    "app.kubernetes.io/managed-by",
    "helm.sh/chart",
]);

// Annotations we keep. These are deployment-tooling breadcrumbs that aren't
// available as labels — chiefly Helm release context and ArgoCD app tracking.
export const RELEVANT_POD_ANNOTATION_KEYS = new Set([
    "meta.helm.sh/release-name",
    "meta.helm.sh/release-namespace",
    "argocd.argoproj.io/tracking-id",
]);

export function pickPodLabels(
    podLabels: Record<string, string> | undefined
): Record<string, string> {
    if (!podLabels) return {};
    return Object.fromEntries(
        Object.entries(podLabels).filter(([k]) => RELEVANT_POD_LABEL_KEYS.has(k))
    );
}

export function pickPodAnnotations(
    podAnnotations: Record<string, string> | undefined
): Record<string, string> {
    if (!podAnnotations) return {};
    return Object.fromEntries(
        Object.entries(podAnnotations).filter(([k]) => RELEVANT_POD_ANNOTATION_KEYS.has(k))
    );
}

export function deriveWorkloadName(
    podName: string,
    podLabels: Record<string, string> | undefined
): string {
    if (podLabels?.["app.kubernetes.io/name"]) {
        return podLabels["app.kubernetes.io/name"];
    }
    if (podLabels?.["app"]) {
        return podLabels["app"];
    }
    return podName.replace(/(-(?=[a-z0-9]*[0-9])[a-z0-9]{4,10}){1,2}$/, "") || podName;
}

// ─── Registry auth ───────────────────────────────────────────────────────────

export async function resolveRegistryAuth(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    secretNames: string[],
): Promise<Record<string, { username: string; password: string }>> {
    const auths: Record<string, { username: string; password: string }> = {};
    for (const name of secretNames) {
        try {
            const secret = await coreApi.readNamespacedSecret({ name, namespace });
            const raw = secret.data?.[".dockerconfigjson"];
            if (!raw) continue;
            const cfg = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
                auths?: Record<string, { auth?: string; username?: string; password?: string }>;
            };
            for (const [registry, creds] of Object.entries(cfg.auths ?? {})) {
                if (creds.auth) {
                    const decoded = Buffer.from(creds.auth, "base64").toString();
                    const colonIdx = decoded.indexOf(":");
                    if (colonIdx !== -1) {
                        auths[registry] = {
                            username: decoded.slice(0, colonIdx),
                            password: decoded.slice(colonIdx + 1),
                        };
                    }
                } else if (creds.username && creds.password) {
                    auths[registry] = { username: creds.username, password: creds.password };
                }
            }
        } catch (err) {
            // Never fatal. A Secret that cannot be read costs the credentials
            // it held, not the scan: whatever else resolved is still used, and
            // an image with no credentials left falls back to an anonymous
            // pull. 403 is the expected shape of a chart installed with
            // `scanner.imagePullSecretNames` — the ClusterRole names the
            // Secrets the agent may read and this one is not among them — so
            // it is called out by name, because naming it is the only way
            // someone who left a Secret off the list finds out which one.
            const status = err instanceof k8s.ApiException ? err.code : undefined;
            log.warn(
                {
                    secret: name,
                    namespace,
                    status,
                    err: err instanceof Error ? err.message : String(err),
                },
                status === 403
                    ? "not permitted to read pull secret — add it to scanner.imagePullSecretNames if it belongs there; continuing without its credentials"
                    : "could not read pull secret — continuing without its credentials"
            );
        }
    }
    return auths;
}

export function buildTempDockerConfig(
    resolved: Record<string, { username: string; password: string }>,
): string {
    const auths: Record<string, { auth: string }> = {};

    const existingConfigDir = process.env.DOCKER_CONFIG;
    if (existingConfigDir) {
        try {
            const existing = JSON.parse(
                fs.readFileSync(path.join(existingConfigDir, "config.json"), "utf8")
            ) as { auths?: Record<string, { auth: string }> };
            for (const [registry, cred] of Object.entries(existing.auths ?? {})) {
                auths[registry] = cred;
            }
        } catch {
            // ignore — static config is optional
        }
    }

    for (const [registry, { username, password }] of Object.entries(resolved)) {
        auths[registry] = { auth: Buffer.from(`${username}:${password}`).toString("base64") };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-cfg-"));
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ auths }));
    return tmpDir;
}

// ─── SBOM generation ─────────────────────────────────────────────────────────

export function generateSBOM(pullRef: string, dockerConfigDir?: string): string {
    const tmpFile = path.join(
        os.tmpdir(),
        `sbom-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );

    execFileSync(
        "syft",
        [`registry:${pullRef}`, "-o", `cyclonedx-json=${tmpFile}`],
        {
            timeout: SYFT_TIMEOUT_MS,
            stdio: "pipe",
            maxBuffer: 10 * 1024 * 1024,
            env: dockerConfigDir
                ? { ...process.env, DOCKER_CONFIG: dockerConfigDir }
                : undefined,
        }
    );

    return tmpFile;
}

