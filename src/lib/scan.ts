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

export const INCLUDE_NAMESPACES = process.env.INCLUDE_NAMESPACES
    ? new Set(
            process.env.INCLUDE_NAMESPACES.split(",")
                .map((n) => n.trim())
                .filter(Boolean)
        )
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
const RELEVANT_POD_LABEL_KEYS = new Set([
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
const RELEVANT_POD_ANNOTATION_KEYS = new Set([
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
            log.warn({ secret: name, namespace, err: err instanceof Error ? err.message : String(err) }, "could not read pull secret");
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

// ─── HTTP with retry ─────────────────────────────────────────────────────────

/**
 * Node's built-in fetch (undici) pools keep-alive connections. When a long-
 * running syft scan sits between two requests to the same host the pooled
 * socket gets reaped by the peer (or kube-proxy/conntrack) while the client
 * still considers it healthy. The next fetch writes onto the dead socket and
 * undici rejects with `fetch failed` / cause `other side closed` (sometimes
 * `ECONNRESET` / `UND_ERR_SOCKET` / `socket hang up`). Retrying on a fresh
 * connection almost always succeeds. Safe even for POST because the request
 * never reached the server.
 */
function isTransientFetchError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const cause = (err as NodeJS.ErrnoException).cause as
        | (Error & { code?: string })
        | undefined;
    const code = cause?.code;
    const msg = cause?.message ?? String(cause ?? "");
    return (
        code === "ECONNRESET" ||
        code === "UND_ERR_SOCKET" ||
        code === "ECONNREFUSED" ||
        code === "EPIPE" ||
        msg.includes("other side closed") ||
        msg.includes("socket hang up")
    );
}

async function fetchWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts = 3,
): Promise<Response> {
    // Inject the scanner version on every outbound request. The server uses
    // this header to stamp `clusters.scanner_version` so the UI can flag
    // clusters running an outdated Helm chart.
    const headers = new Headers(init.headers);
    headers.set("X-Scanner-Version", SCANNER_VERSION);
    const finalInit: RequestInit = { ...init, headers };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fetch(url, finalInit);
        } catch (err) {
            lastErr = err;
            if (attempt === maxAttempts || !isTransientFetchError(err)) throw err;
            const backoffMs = 200 * 2 ** (attempt - 1);
            log.warn(
                {
                    url,
                    attempt,
                    maxAttempts,
                    backoffMs,
                    err: err instanceof Error ? err.message : String(err),
                },
                "transient fetch error, retrying",
            );
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
    throw lastErr;
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

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadSBOM(
    sbomFile: string,
    projectName: string,
    version: string,
    groupName: string,
    registry: string | undefined,
    imageDigest: string | undefined,
    imageRef: string,
    workloadKind: string | undefined,
    extraLabels?: Record<string, string>,
    extraAnnotations?: Record<string, string>,
): Promise<void> {
    const url = new URL(`${API_URL}/v1/sboms/upload/cyclonedx`);
    url.searchParams.set("projectName", projectName);
    url.searchParams.set("version", version);
    url.searchParams.set("groupName", groupName);
    url.searchParams.set("groupLabels", JSON.stringify({ type: "namespace" }));
    if (registry) url.searchParams.set("registry", registry);
    if (imageDigest) url.searchParams.set("imageDigest", imageDigest);
    url.searchParams.set("imageRef", imageRef);

    const projectLabels: Record<string, string> = { type: "container-image" };
    if (workloadKind) projectLabels.workloadKind = workloadKind;
    url.searchParams.set("projectLabels", JSON.stringify(projectLabels));

    // Merge labels + annotations into a single labels bag. The allowlists are
    // disjoint by key (Helm sets `helm.sh/chart` as a label, `meta.helm.sh/*`
    // as annotations) so this avoids any DB schema change while keeping the
    // useful breadcrumbs queryable in `sboms.labels`.
    const labels: Record<string, string> = { ...extraLabels, ...extraAnnotations };
    if (CLUSTER_NAME) labels.cluster = CLUSTER_NAME;
    if (CLUSTER_ID) labels.clusterId = CLUSTER_ID;
    if (Object.keys(labels).length > 0) {
        url.searchParams.set("labels", JSON.stringify(labels));
    }

    url.searchParams.set("isCurrent", "true");

    const sbomBytes = fs.readFileSync(sbomFile);
    const blob = new Blob([sbomBytes], { type: "application/json" });

    log.info(
        { url: url.origin + url.pathname, projectName, groupName, sbomBytes: sbomBytes.byteLength },
        "uploading SBOM",
    );

    const response = await fetchWithRetry(url.toString(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY!,
        },
        body: blob,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }
}

// ─── Digest check ────────────────────────────────────────────────────────────

export async function checkExistingSbom(
    imageDigest: string,
    projectName: string,
    groupName: string,
): Promise<boolean> {
    const url = new URL(`${API_URL}/v1/sboms/check`);
    url.searchParams.set("imageDigest", imageDigest);
    url.searchParams.set("projectName", projectName);
    url.searchParams.set("groupName", groupName);

    log.info({ imageDigest, projectName, groupName }, "checking for existing SBOM");
    try {
        const response = await fetchWithRetry(url.toString(), {
            headers: { "X-API-Key": API_KEY! },
        });
        if (!response.ok) return false;
        const data = await response.json() as { exists: boolean };
        const exists = data.exists === true;
        log.info({ imageDigest, projectName, groupName, exists }, "existing SBOM check result");
        return exists;
    } catch (err) {
        log.warn({ imageDigest, projectName, groupName, err: err instanceof Error ? err.message : String(err) }, "existing SBOM check failed");
        return false;
    }
}

// ─── Per-image scan ──────────────────────────────────────────────────────────

export async function scanAndUpload(
    info: ImageInfo,
    coreApi: k8s.CoreV1Api,
    parseImageRef: (ref: string) => { version: string; registry: string | undefined },
    label: string,
): Promise<"skipped" | "ok" | "failed"> {
    if (SKIP_EXISTING_DIGESTS && info.digest) {
        const projectName = `${info.workloadName}/${info.containerName}`;
        const exists = await checkExistingSbom(info.digest, projectName, info.namespace);
        if (exists) return "skipped";
    }

    let dockerConfigDir: string | undefined;
    let sbomFile: string | undefined;
    try {
        if (RESOLVE_IMAGE_PULL_SECRETS && info.imagePullSecrets.length > 0) {
            const resolved = await resolveRegistryAuth(coreApi, info.namespace, info.imagePullSecrets);
            if (Object.keys(resolved).length > 0) {
                dockerConfigDir = buildTempDockerConfig(resolved);
            }
        }

        try {
            sbomFile = generateSBOM(info.pullRef, dockerConfigDir);
        } catch (err) {
            log.error({ image: info.displayName, label, err: err instanceof Error ? err.message : String(err) }, "syft failed");
            return "failed";
        }

        const { version, registry } = parseImageRef(info.displayName);
        const projectName = `${info.workloadName}/${info.containerName}`;
        try {
            await uploadSBOM(sbomFile, projectName, version, info.namespace, registry, info.digest, info.pullRef, info.workloadKind, info.podLabels, info.podAnnotations);
            log.info({ projectName, version, namespace: info.namespace }, "upload succeeded");
            return "ok";
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause;
            const detail = cause instanceof Error ? `: ${cause.message}` : cause ? `: ${cause}` : "";
            log.error({ projectName, namespace: info.namespace, err: msg + detail }, "upload failed");
            return "failed";
        }
    } finally {
        if (dockerConfigDir) try { fs.rmSync(dockerConfigDir, { recursive: true }); } catch { /* ignore */ }
        if (sbomFile) try { fs.unlinkSync(sbomFile); } catch { /* ignore */ }
    }
}
