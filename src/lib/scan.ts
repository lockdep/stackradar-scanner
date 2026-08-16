import * as k8s from "@kubernetes/client-node";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { log } from "./logger.js";
import { parseImageRef } from "../parse-image-ref.js";

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

// Glob patterns for images that are never scanned, whatever namespace they run
// in. Read here, compiled to regexes once under "Image filtering" below rather
// than per pod event — the informer calls into that on every pod add and update
// in the cluster.
const excludeImagePatterns = (process.env.EXCLUDE_IMAGES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

export const SYFT_TIMEOUT_MS = parseInt(process.env.SYFT_TIMEOUT_MS ?? "300000", 10);
export const CLUSTER_NAME = process.env.CLUSTER_NAME?.trim() || undefined;
export const CLUSTER_ID = process.env.STACKRADAR_CLUSTER_ID?.trim() || undefined;
export const CONCURRENT_SCANS = Math.max(1, parseInt(process.env.CONCURRENT_SCANS ?? "5", 10));
export const SKIP_EXISTING_DIGESTS = (process.env.SKIP_EXISTING_DIGESTS ?? "true") !== "false";
export const RESOLVE_IMAGE_PULL_SECRETS = (process.env.RESOLVE_IMAGE_PULL_SECRETS ?? "true") !== "false";

/**
 * Read the pod's controller (Deployment, StatefulSet, DaemonSet, Job, CronJob)
 * to recover the chart context the pod template does not carry.
 *
 * On by default because without it the agent files chart-managed workloads under
 * "Unmanaged" — a confident, wrong statement about the cluster. Off is the
 * pod-only behaviour that shipped before, and a 403 degrades to it on its own.
 */
export const RESOLVE_WORKLOAD_OWNERS = (process.env.RESOLVE_WORKLOAD_OWNERS ?? "true") !== "false";

/**
 * Read ArgoCD `Application` objects to fill in the repository URL and target
 * revision behind a GitOps-delivered workload.
 *
 * Silent when the CRD is absent — the overwhelmingly common case on a cluster
 * with no ArgoCD — so it costs a single 404 per report there.
 */
export const RESOLVE_ARGOCD_APPLICATIONS = (process.env.RESOLVE_ARGOCD_APPLICATIONS ?? "true") !== "false";

/**
 * Where ArgoCD's `Application` objects live.
 *
 * Needed because `argocd.argoproj.io/tracking-id` names the app but not its
 * namespace — Argo's tracking ID is `<app>:<group>/<Kind>:<ns>/<name>`, and the
 * `<app>` half is bare unless apps-in-any-namespace is switched on. The
 * configured value is what the agent reports until an `Application` object
 * corrects it.
 */
export const ARGOCD_NAMESPACE = process.env.ARGOCD_NAMESPACE?.trim() || "argocd";

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

/**
 * The allowlisted labels and annotations of a pod's **controller**.
 *
 * The controller is where the packaging decision was recorded. Helm writes
 * `meta.helm.sh/release-*` onto the objects it applies and never onto the pod
 * template; ArgoCD annotates what it applies and nothing propagates that to the
 * pod either; and an operator that generates a StatefulSet from a CR writes its
 * own label set for the pods, dropping the chart labels on the way through.
 * Reading one object further up is what recovers all three.
 */
export interface OwnerMetadata {
    labels: Record<string, string>;
    annotations: Record<string, string>;
}

/** Keyed by {@link ownerKey}. Built once per report; see `owner-cache.ts`. */
export type OwnerMetadataLookup = ReadonlyMap<string, OwnerMetadata>;

export const ownerKey = (namespace: string, kind: string, name: string) =>
    `${namespace}\u0000${kind}\u0000${name}`;

export interface ImageInfo {
    pullRef: string;
    displayName: string;
    digest: string | undefined;
    namespace: string;
    workloadName: string;
    containerName: string;
    /**
     * Resolved from `ownerReferences`. **`null` when the chain dead-ends** —
     * never the literal `"Pod"` unless the pod genuinely has no owner. A
     * guessed kind becomes a wrong `kubectl set image deployment/x` for a
     * StatefulSet, which is worse than admitting we do not know.
     */
    workloadKind: string | null;
    /** Init containers run, so their images can be vulnerable, but they do not serve traffic. */
    init: boolean;
    /** Earliest pod start, for "days exposed". */
    startedAt: Date | undefined;
    podLabels: Record<string, string>;
    podAnnotations: Record<string, string>;
    /**
     * The controller's allowlisted metadata, empty when it was not resolved.
     *
     * Kept **beside** the pod's rather than merged into it, so the two
     * allowlists stay separately auditable and the merge — where the pod wins —
     * happens in one place, {@link mergedMetadata}.
     */
    ownerLabels: Record<string, string>;
    ownerAnnotations: Record<string, string>;
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

// ─── Image filtering ─────────────────────────────────────────────────────────

/**
 * Drops the `:tag` and the `@sha256:...` from an image reference.
 *
 * So that a pattern written once keeps working as the tag moves. The colon is
 * only a tag separator when it comes after the last `/` — `registry:5000/pause`
 * is a registry with a port, not an image with a tag, and truncating it there
 * would turn the pattern into one that matches the host alone.
 */
export function stripTagAndDigest(imageRef: string): string {
    const withoutDigest = imageRef.split("@")[0]!;
    const lastSlash = withoutDigest.lastIndexOf("/");
    const lastColon = withoutDigest.lastIndexOf(":");
    return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/**
 * Compiles one exclusion pattern, or returns `null` for one that cannot work.
 *
 * `*` is the only wildcard, and it spans `/` — `registry.k8s.io/*` is meant to
 * cover nested repositories too. Everything else is escaped, so a pattern is a
 * literal match plus wildcards and nothing more; anchoring both ends is what
 * keeps `registry.k8s.io/*` off `myregistry.io/registry.k8s.io-mirror/app`.
 *
 * A pattern is rejected rather than applied when it carries a tag or a digest:
 * matching happens against the stripped name, so such a pattern could never
 * fire, and silently keeping it means someone believes an image is excluded
 * while it is being scanned. Rejecting is the safe direction — the cost is a
 * scan that was meant to be skipped, not coverage lost.
 */
function compileExcludePattern(pattern: string): RegExp | null {
    if (stripTagAndDigest(pattern) !== pattern) {
        log.warn(
            { pattern },
            "ignoring EXCLUDE_IMAGES pattern with a tag or digest — patterns match the " +
            "image name with both stripped, so this one can never match; drop the " +
            "`:tag` / `@sha256:...` from it"
        );
        return null;
    }

    try {
        const escaped = pattern
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\\*/g, ".*");
        return new RegExp(`^${escaped}$`);
    } catch (err) {
        // Unreachable with everything escaped, and kept anyway: a bad glob in a
        // values file must not take a cluster's coverage offline, and the only
        // way to be sure of that is to not throw here.
        log.warn(
            { pattern, err: err instanceof Error ? err.message : String(err) },
            "ignoring unparseable EXCLUDE_IMAGES pattern"
        );
        return null;
    }
}

const excludeImageRegexes: RegExp[] = [];

// The patterns that compiled, in the order they were given. Exported for the
// startup log: an over-broad pattern silently drops coverage, and this line is
// where someone finds out which patterns their cluster is actually running.
export const EXCLUDE_IMAGES: string[] = [];

for (const pattern of excludeImagePatterns) {
    const regex = compileExcludePattern(pattern);
    if (regex) {
        excludeImageRegexes.push(regex);
        EXCLUDE_IMAGES.push(pattern);
    }
}

export function shouldScanImage(imageRef: string): boolean {
    if (excludeImageRegexes.length === 0) return true;
    const name = stripTagAndDigest(imageRef);
    return !excludeImageRegexes.some((re) => re.test(name));
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
    // Helm's pre-3.0 label set, still emitted by charts that never migrated —
    // `release` is the release name, `chart` is `<name>-<version>`, `heritage`
    // is `Helm`. kube-prometheus-stack is the common case: it carries both
    // spellings, and only the legacy `chart` names the umbrella chart.
    "release",
    "chart",
    "heritage",
]);

// Annotations we keep. These are deployment-tooling breadcrumbs that aren't
// available as labels — chiefly Helm release context.
//
// `argocd.argoproj.io/tracking-id` is deliberately *not* here. It was, from
// phase 1 onwards, and it never once matched: ArgoCD annotates the objects it
// applies and nothing propagates that to the pod template. It lives in the
// owner allowlist below, where it is actually written.
export const RELEVANT_POD_ANNOTATION_KEYS = new Set([
    "meta.helm.sh/release-name",
    "meta.helm.sh/release-namespace",
]);

// The same boundary, one object up: what the agent keeps off a pod's Deployment,
// StatefulSet, DaemonSet, Job or CronJob.
//
// Spelled out rather than derived from the pod sets. Deriving them would make
// widening one silently widen the other, and these are the sets README.md
// promises customers — each has to be its own visible diff.
export const RELEVANT_OWNER_LABEL_KEYS = new Set([
    "app",
    "version",
    "app.kubernetes.io/name",
    "app.kubernetes.io/version",
    "app.kubernetes.io/component",
    "app.kubernetes.io/part-of",
    "app.kubernetes.io/instance",
    "app.kubernetes.io/managed-by",
    "helm.sh/chart",
    "release",
    "chart",
    "heritage",
]);

export const RELEVANT_OWNER_ANNOTATION_KEYS = new Set([
    // Where Helm actually writes these — on the object it applies, never on the
    // pod template it renders inside it.
    "meta.helm.sh/release-name",
    "meta.helm.sh/release-namespace",
    // `<app>:<group>/<Kind>:<namespace>/<name>`. The delivery layer, not the
    // packaging one: see `applicationForWorkload`.
    "argocd.argoproj.io/tracking-id",
]);

function pick(
    source: Record<string, string> | undefined,
    allowed: ReadonlySet<string>
): Record<string, string> {
    if (!source) return {};
    return Object.fromEntries(Object.entries(source).filter(([k]) => allowed.has(k)));
}

export function pickPodLabels(
    podLabels: Record<string, string> | undefined
): Record<string, string> {
    return pick(podLabels, RELEVANT_POD_LABEL_KEYS);
}

export function pickPodAnnotations(
    podAnnotations: Record<string, string> | undefined
): Record<string, string> {
    return pick(podAnnotations, RELEVANT_POD_ANNOTATION_KEYS);
}

export function pickOwnerLabels(
    ownerLabels: Record<string, string> | undefined
): Record<string, string> {
    return pick(ownerLabels, RELEVANT_OWNER_LABEL_KEYS);
}

export function pickOwnerAnnotations(
    ownerAnnotations: Record<string, string> | undefined
): Record<string, string> {
    return pick(ownerAnnotations, RELEVANT_OWNER_ANNOTATION_KEYS);
}

/**
 * Everything known about where a workload came from, pod and controller merged.
 *
 * **The pod wins on conflict.** It is the more specific object and it is what
 * the container actually runs under; the controller's copy is the fallback for
 * the keys the pod template never received. Owner metadata is therefore only
 * ever additive, which is what keeps this change incapable of *changing* an
 * attribution that already worked.
 */
export function mergedMetadata(info: ImageInfo): {
    labels: Record<string, string>;
    annotations: Record<string, string>;
} {
    return {
        labels: { ...info.ownerLabels, ...info.podLabels },
        annotations: { ...info.ownerAnnotations, ...info.podAnnotations },
    };
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

// ─── Owner resolution ────────────────────────────────────────────────────────

/**
 * The controller a pod belongs to, from `ownerReferences` alone.
 *
 * **No extra RBAC and no API calls.** The reference itself carries `kind` and
 * `name`, which is all that is needed — reading the controller objects would
 * mean asking customers for `deployments: get` across the fleet to learn
 * something already in the pod.
 *
 * The one inference is ReplicaSet → Deployment. A ReplicaSet created by a
 * Deployment is named `<deployment>-<pod-template-hash>`, and the hash is on the
 * pod as the `pod-template-hash` label, so the Deployment's name is the RS name
 * with that suffix removed. When the label is absent the ReplicaSet was not
 * created by a Deployment (or we cannot prove it was), and the honest answer is
 * `ReplicaSet` with its own name rather than a Deployment we invented.
 *
 * A Job-owned pod reports `Job`, not `CronJob`: resolving the second hop needs
 * the Job object, and `Job` is true where `CronJob` might not be.
 *
 * A pod with no owner at all is genuinely a bare Pod, and that is the only case
 * that reports `"Pod"`.
 */
export function resolveOwner(pod: k8s.V1Pod): { kind: string | null; name: string } {
    const fallbackName = pod.metadata?.name ?? "";
    const refs = pod.metadata?.ownerReferences ?? [];
    const owner = refs.find((r) => r.controller) ?? refs[0];

    if (!owner?.kind || !owner.name) {
        // No owner: a bare pod. `deriveWorkloadName` still strips what looks
        // like a generated suffix, because a bare pod created by hand from a
        // template is common enough to be worth collapsing.
        return { kind: refs.length === 0 ? "Pod" : null, name: deriveWorkloadName(fallbackName, pod.metadata?.labels) };
    }

    if (owner.kind === "ReplicaSet") {
        const hash = pod.metadata?.labels?.["pod-template-hash"];
        if (hash && owner.name.endsWith(`-${hash}`)) {
            return { kind: "Deployment", name: owner.name.slice(0, -(hash.length + 1)) };
        }
        return { kind: "ReplicaSet", name: owner.name };
    }

    return { kind: owner.kind, name: owner.name };
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

const execFileAsync = promisify(execFile);

/**
 * Runs syft against `pullRef` and returns the path to the CycloneDX output.
 *
 * Async on purpose. The synchronous `execFileSync` blocks the event loop for
 * the whole run — up to `SYFT_TIMEOUT_MS`, five minutes by default — and while
 * it does, nothing else in the process gets a turn. The health server is the
 * casualty that shows up first: the kubelet's connection is accepted into the
 * listen backlog but never answered, so the liveness probe reports "context
 * deadline exceeded while awaiting headers" (not `connection refused` — the
 * listener is fine, the loop is not) and the pod is killed mid-scan at
 * `failureThreshold` × `periodSeconds`.
 *
 * Keeping the loop free is also what makes the `Semaphore` in `watch.ts` mean
 * anything: under `execFileSync` every scan ran serially no matter what
 * `CONCURRENT_SCANS` was set to.
 */
export async function generateSBOM(pullRef: string, dockerConfigDir?: string): Promise<string> {
    const tmpFile = path.join(
        os.tmpdir(),
        `sbom-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );

    await execFileAsync(
        "syft",
        [`registry:${pullRef}`, "-o", `cyclonedx-json=${tmpFile}`],
        {
            timeout: SYFT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            env: dockerConfigDir
                ? { ...process.env, DOCKER_CONFIG: dockerConfigDir }
                : undefined,
        }
    );

    return tmpFile;
}


// ─── Pod inspection ──────────────────────────────────────────────────────────

/**
 * Every container in a pod that this scanner is configured to care about.
 *
 * Split out of `handlePod` so the inventory report and the scan queue are
 * derived from exactly the same rule. Any drift between them would show up in
 * the UI as a "discovered" count that never finishes converging on "scanned".
 */
export function podImages(pod: k8s.V1Pod, owners?: OwnerMetadataLookup): ImageInfo[] {
    const namespace = pod.metadata?.namespace ?? "default";
    if (!shouldScan(namespace)) return [];

    const phase = pod.status?.phase;
    if (phase !== "Running" && phase !== "Succeeded" && phase !== "Failed") return [];

    /* Init containers are tagged rather than merged. They run, so their images
       can be vulnerable, but they are not serving traffic — the flag lets the
       control plane rank them differently instead of guessing from the name. */
    const allStatuses = [
        ...(pod.status?.containerStatuses ?? []).map((cs) => ({ cs, init: false })),
        ...(pod.status?.initContainerStatuses ?? []).map((cs) => ({ cs, init: true })),
    ];

    const images: ImageInfo[] = [];
    const owner = resolveOwner(pod);
    const startedAt = pod.status?.startTime ? new Date(pod.status.startTime) : undefined;

    /* Empty when owner resolution is off, denied, or simply has not run — the
       scan hot path calls this with no lookup at all. Empty is the same shape
       as "the controller carried nothing", and both mean pod-only attribution;
       what separates them for the *report* is the warning `watch.ts` sends. */
    const ownerMetadata = owner.kind
        ? owners?.get(ownerKey(namespace, owner.kind, owner.name))
        : undefined;

    for (const { cs, init } of allStatuses) {
        const isActive = cs.state?.running || cs.state?.terminated;
        if (!cs.imageID || !isActive) continue;

        // Ahead of the dedup key and everything after it: an excluded image
        // costs nothing at all, not even a slot in `seenDigests`. Matched on
        // `cs.image` — the reference the pod spec asked for, which is what the
        // patterns are written against — rather than on the resolved
        // `imageID`, which for many runtimes is a bare digest with no name in
        // it to match.
        if (!shouldScanImage(cs.image ?? "")) {
            log.debug(
                { image: cs.image, namespace, container: cs.name },
                "image excluded by EXCLUDE_IMAGES, skipping"
            );
            continue;
        }

        const normalized = cs.imageID.replace(/^docker-pullable:\/\//, "");
        const digestMatch = normalized.match(/sha256:[a-f0-9]{64}/);
        if (!digestMatch) continue;
        const digest = digestMatch[0];

        const pullRef = normalized.includes("@sha256:")
            ? normalized
            : `${cs.image}@${digest}`;

        const rawLabels = pod.metadata?.labels;
        const pullSecrets = (pod.spec?.imagePullSecrets ?? [])
            .map((s) => s.name)
            .filter((n): n is string => Boolean(n));

        images.push({
            pullRef,
            displayName: cs.image ?? pullRef,
            digest,
            namespace,
            // The owner's real name, not a regex guess at what the pod-name
            // suffix might have been.
            workloadName: owner.name,
            containerName: cs.name ?? owner.name,
            workloadKind: owner.kind,
            init,
            startedAt,
            podLabels: pickPodLabels(rawLabels),
            podAnnotations: pickPodAnnotations(pod.metadata?.annotations),
            ownerLabels: ownerMetadata?.labels ?? {},
            ownerAnnotations: ownerMetadata?.annotations ?? {},
            imagePullSecrets: pullSecrets,
        });
    }

    return images;
}

// ─── Inventory ───────────────────────────────────────────────────────────────

/**
 * The `POST /v1/inventory` v3 payload.
 *
 * Derived from `sbom-tracker/docs/contracts/inventory-v3.md`, which is the
 * shared definition both repos encode. Change the contract first.
 */

export const INVENTORY_VERSION = 3;

export interface InventoryContainer {
    name: string;
    init: boolean;
    imageRef: string;
    imageDigest: string;
    /** `null` for a digest-pinned deployment. Never `"latest"`. */
    imageTag: string | null;
    registry: string | null;
    repository: string | null;
    /** Pods **observed** running this container on this digest. */
    runningPods: number;
}

export interface InventoryWorkload {
    /** `null` when `ownerReferences` could not be resolved. */
    kind: string | null;
    name: string;
    /** What **packaged** this — a Helm chart. Natural-key reference into `releases[]`. */
    release: { name: string; namespace: string } | null;
    /**
     * What **delivers** this — an ArgoCD or Flux app. Natural-key reference into
     * `applications[]`.
     *
     * A second, independent reference rather than a value on the release,
     * because a workload legitimately has both at different layers: ArgoCD
     * commonly deploys *via* Helm, and the chart version is what a CVE report
     * cites while the Argo app is where the fix is made.
     */
    application: { name: string; namespace: string } | null;
    runningPods: number;
    firstStartedAt: string | null;
    labels: Record<string, string> | null;
    containers: InventoryContainer[];
}

export interface InventoryNamespace {
    name: string;
    /** `null` = not collected. Phase 2 of `deployment-context-collection.md`. */
    labels: Record<string, string> | null;
    workloads: InventoryWorkload[];
}

/**
 * A Helm release — the **packaging** layer.
 *
 * No `source` field. Every row here is a Helm release now that the delivery
 * layer has its own relation, and a column whose only value is `"helm"` is a
 * column that invites someone to write `"argocd"` into it later. Flux is not an
 * exception: it installs *through* the Helm SDK, so a `HelmRelease` CR produces
 * a genuine release here **and** an entry in `applications[]`.
 */
export interface InventoryRelease {
    name: string;
    /** The **release's** own namespace, from `meta.helm.sh/release-namespace`. */
    namespace: string;
    chartName: string | null;
    chartVersion: string | null;
    /**
     * From `app.kubernetes.io/version`. Kept distinct from `chartVersion` even
     * when the two are byte-identical: plenty of charts stamp their own version
     * into this label, so equality is not evidence they are the same thing and
     * nothing downstream may derive one from the other.
     */
    appVersion: string | null;
    /** `null` until an `Application` object supplies it — see phase C. */
    repoUrl: string | null;
}

/** The tools that deliver a workload. Both may package *via* Helm. */
export const GITOPS_TOOLS = ["argocd", "flux"] as const;
export type GitopsTool = typeof GITOPS_TOOLS[number];

/**
 * A GitOps application — the **delivery** layer.
 *
 * Its own relation rather than a `source` value on the release, because the two
 * answer different questions: "what chart packaged this, at what version" and
 * "what delivers this, and where do I change it". On a cluster where ArgoCD
 * renders Helm charts most workloads have both answers, and both are true.
 */
export interface InventoryApplication {
    name: string;
    /** The **application object's** own namespace, e.g. `argocd`. */
    namespace: string;
    tool: GitopsTool;
    /** All four are `null` until the `Application` object is read — phase C. */
    repoUrl: string | null;
    targetRevision: string | null;
    chart: string | null;
    path: string | null;
    destinationNamespace: string | null;
}

export interface InventoryReport {
    version: number;
    reportedAt: string;
    informerSynced: boolean;
    /**
     * Whether the controller metadata behind every attribution was readable.
     *
     * `false` means the agent could not `get` the pods' controllers — RBAC
     * absent, or `scanner.resolveWorkloadOwners` switched off — so a workload
     * reported without a release may still be chart-managed. Distinguishing
     * "no chart claims this" from "we could not look" is the whole point: they
     * render identically otherwise, which is what made this class of bug
     * invisible for a release.
     */
    ownerMetadataCollected: boolean;
    releases: InventoryRelease[];
    applications: InventoryApplication[];
    namespaces: InventoryNamespace[];
}

/**
 * Split `helm.sh/chart` into a chart name and version.
 *
 * The label is `<name>-<version>` with no delimiter of its own, and chart names
 * legitimately contain hyphens (`kube-prometheus-stack-51.2.0`). So the split
 * is at the last hyphen whose tail begins a plausible version — a digit, or a
 * `v` followed by one. Anything else is a chart name with no version in it,
 * which is a real case for locally-built charts.
 */
export function parseHelmChartLabel(label: string | undefined): {
    chartName: string | null;
    chartVersion: string | null;
} {
    if (!label) return { chartName: null, chartVersion: null };

    for (let i = label.lastIndexOf("-"); i > 0; i = label.lastIndexOf("-", i - 1)) {
        const tail = label.slice(i + 1);
        if (/^v?\d/.test(tail)) {
            return { chartName: label.slice(0, i), chartVersion: tail };
        }
    }
    return { chartName: label, chartVersion: null };
}

/**
 * Whether an object's own metadata says "Helm made this", in Helm's pre-3.0
 * spelling.
 *
 * `release`, `chart` and `heritage` carry no prefix, and the label spec is
 * explicit that "labels without a prefix are private to users" — `release:
 * stable` as somebody's channel marker is a legitimate use of that key. So the
 * unprefixed set is only read as Helm's when something else in the same object
 * agrees: `heritage: Helm`, a prefixed `helm.sh/chart`, or a `chart` label that
 * parses as `<name>-<version>` the way Helm writes it.
 */
function hasHelmSpelling(labels: Record<string, string>): boolean {
    return (
        (labels["heritage"] ?? "").toLowerCase() === "helm" ||
        !!labels["helm.sh/chart"] ||
        (!!labels["chart"] && parseHelmChartLabel(labels["chart"]).chartVersion !== null)
    );
}

/**
 * The Helm release a workload belongs to, from the pod **and its controller**.
 *
 * Three rules, each a correction of something the pod-only version got wrong on
 * a real cluster.
 *
 * **The evidence spans both objects.** The pod is the one link in the chain that
 * usually does *not* carry chart context: Helm writes `meta.helm.sh/release-*`
 * onto the object it applies and never onto the pod template, and an operator
 * that generates a StatefulSet from a CR writes its own label set for the pods,
 * dropping `chart` / `heritage` / `release` on the way through. The spec's own
 * advice — "they should be applied on every resource object" — assumes a reader
 * that looks at the object it is asking about. {@link mergedMetadata} is that
 * reader, with the pod winning any key both objects carry.
 *
 * **The evidence must be positive.** The previous rule vetoed on
 * `app.kubernetes.io/managed-by`, but the spec defines that label as "the tool
 * being used to manage the *operation* of an application" — so `managed-by:
 * prometheus-operator` on a StatefulSet that Helm packaged is a true statement,
 * not a contradiction, and it is the label that hid two whole releases. It is
 * absent on three quarters of a typical fleet anyway, so a rule of the form
 * "trust this only when managed-by says Helm" starts by discarding the
 * majority. It stays here as one way to say Helm, never as a way to say
 * not-Helm.
 *
 * **`instance` is the last source for a name.** The spec defines it as a unique
 * *instance* name, not a release name — prometheus-operator correctly stamps
 * `instance: kube-prometheus-stack-alertmanager` on one instance of the
 * `kube-prometheus-stack` release, and reading it as a release would split one
 * release into three. That is the failure the old veto existed to prevent, and
 * the ordering below prevents it without the veto.
 */
function releaseForPod(info: ImageInfo): InventoryRelease | null {
    const { labels, annotations } = mergedMetadata(info);

    /* Authoritative when present: Helm wrote it, so both the name and the
       release's own namespace are facts rather than inferences. Now actually
       reachable — this is the annotation that lives on the controller. */
    const annotatedName = annotations["meta.helm.sh/release-name"];
    const annotatedNamespace = annotations["meta.helm.sh/release-namespace"];

    const helmSpelling = hasHelmSpelling(labels);
    const helmEvidence =
        !!annotatedName ||
        (labels["app.kubernetes.io/managed-by"] ?? "").toLowerCase() === "helm" ||
        helmSpelling;
    if (!helmEvidence) return null;

    /* Prefixed spelling first — it is the one the spec governs. The unprefixed
       `chart` is read only under the corroboration `helmSpelling` establishes. */
    const chartLabel = labels["helm.sh/chart"] ?? (helmSpelling ? labels["chart"] : undefined);

    /* `release` outranks `app.kubernetes.io/instance` — but only corroborated,
       because unprefixed keys are user-private per the spec. Uncorroborated,
       the spec label is the safer of the two. */
    const name =
        annotatedName ??
        (helmSpelling ? labels["release"] : undefined) ??
        labels["app.kubernetes.io/instance"] ??
        labels["release"];
    if (!name) return null;

    /* The *release's* namespace, not the workload's — a chart may deploy
       resources into other namespaces, and keying on the workload's namespace
       silently splits one release into several. Only the annotation can tell
       them apart; with labels alone the workload's namespace is the honest
       best answer, and it is right for every single-namespace release. */
    const namespace = annotatedNamespace ?? info.namespace;

    const { chartName, chartVersion } = parseHelmChartLabel(chartLabel);

    return {
        name,
        namespace,
        chartName,
        chartVersion,
        /* The app's version per the spec, and charts get it wrong often enough
           that it must never be the thing a fix is computed from — five of
           fifteen releases on the reference cluster stamp the *chart* version
           here. Collected, kept distinct from `chartVersion`, and never
           derived from it. */
        appVersion: labels["app.kubernetes.io/version"] ?? null,
        // `null` means unknown rather than "no repo". Without it, fleet-wide
        // "all releases of chart X" is a name match — see phase C.
        repoUrl: null,
    };
}

/**
 * Split an ArgoCD tracking annotation into the `Application` it names.
 *
 * ```
 * kube-prometheus-stack:apps/StatefulSet:monitoring/alertmanager-kps
 * └── app                └── tracked GVK  └── tracked object
 * ```
 *
 * Only the first field is of interest — the rest re-states the object we are
 * already looking at. With apps-in-any-namespace switched on that field is
 * `<namespace>/<app>`; bare otherwise, and then the app's namespace is not in
 * the annotation at all and the caller supplies the configured one.
 *
 * The trailing fields are still required to be present: a bare string with no
 * `:` in it is not a tracking ID, and treating it as an app name would invent a
 * delivery layer out of an unrelated annotation value.
 */
export function parseArgocdTrackingId(
    value: string | undefined
): { name: string; namespace: string | null } | null {
    if (!value) return null;
    const separator = value.indexOf(":");
    if (separator <= 0) return null;

    const app = value.slice(0, separator);
    if (!app) return null;

    const slash = app.indexOf("/");
    if (slash === -1) return { name: app, namespace: null };

    const namespace = app.slice(0, slash);
    const name = app.slice(slash + 1);
    if (!namespace || !name) return null;
    return { name, namespace };
}

/**
 * The GitOps application delivering a workload.
 *
 * Phase B reads the tracking annotation alone, so everything but the name and
 * namespace is `null` — `repoUrl`, `targetRevision`, `chart` and `path` come
 * from the `Application` object in phase C, and {@link mergeApplication} folds
 * them in when it is available.
 */
function applicationForWorkload(
    info: ImageInfo,
    argocdNamespace: string
): InventoryApplication | null {
    const { annotations } = mergedMetadata(info);
    const tracked = parseArgocdTrackingId(annotations["argocd.argoproj.io/tracking-id"]);
    if (!tracked) return null;

    return {
        name: tracked.name,
        namespace: tracked.namespace ?? argocdNamespace,
        tool: "argocd",
        repoUrl: null,
        targetRevision: null,
        chart: null,
        path: null,
        destinationNamespace: null,
    };
}

/**
 * Fold one pod's view of a release into what the other pods already said.
 *
 * Not "first one wins", because of subcharts. Every pod of the
 * `kube-prometheus-stack` release carries its *own* subchart in `helm.sh/chart`
 * — `grafana-11.3.7` on one, `kube-state-metrics-7.2.2` on the next — so
 * whichever pod the informer happened to hand over last would name the whole
 * release, and the answer would change between reports for no reason in the
 * cluster.
 *
 * The umbrella chart is the one whose name matches the release, so it wins
 * outright. Failing that a named chart beats an unnamed one, and the result no
 * longer depends on iteration order.
 */
export function mergeRelease(
    existing: InventoryRelease | undefined,
    incoming: InventoryRelease,
): InventoryRelease {
    if (!existing) return incoming;
    if (existing.chartName === existing.name) return existing;
    if (incoming.chartName === incoming.name) return incoming;
    if (!existing.chartName && incoming.chartName) return incoming;
    return existing;
}

/**
 * Fold one workload's view of an application into what the others already said.
 *
 * Same shape as {@link mergeRelease}, simpler tie-break: every workload an app
 * delivers reports the identical bare row derived from the tracking annotation,
 * so the only interesting case is a row enriched from the `Application` object
 * meeting a bare one. The enriched one wins whichever order they arrive in.
 */
export function mergeApplication(
    existing: InventoryApplication | undefined,
    incoming: InventoryApplication,
): InventoryApplication {
    if (!existing) return incoming;
    if (existing.repoUrl) return existing;
    if (incoming.repoUrl) return incoming;
    return existing;
}

const releaseKey = (namespace: string, name: string) => `${namespace}\u0000${name}`;

/** Same natural key as a release's, over the application's own namespace. */
export const applicationKey = (namespace: string, name: string) =>
    `${namespace}\u0000${name}`;

/**
 * Everything the report needs beyond the pods themselves.
 *
 * Both lookups are resolved once per publish, off the informer's hot path:
 * controller metadata changes on deploy rather than on pod churn, and an
 * `Application` object changes less often than that.
 */
export interface InventoryContext {
    /** Controller metadata, keyed by {@link ownerKey}. See `owner-cache.ts`. */
    owners?: OwnerMetadataLookup;
    /**
     * `false` when the controllers could not be read at all — RBAC absent, or
     * the lookup switched off. Carried through so the control plane can tell
     * "no chart claims this" from "we could not look"; the two are otherwise
     * indistinguishable, which is what made this class of bug invisible.
     */
    ownerMetadataCollected?: boolean;
    /**
     * `Application` objects keyed by {@link applicationKey}, from phase C.
     * Absent when the CRD is not installed or the lookup is off — the
     * applications the tracking annotation names still reach the report, just
     * without a repository URL.
     */
    applications?: ReadonlyMap<string, InventoryApplication>;
    /** Where `Application` objects live when a tracking ID does not say. */
    argocdNamespace?: string;
}

/**
 * Collapse the informer's pod cache into one inventory report.
 *
 * Two aggregation rules, and both matter:
 *
 * - **Workloads collapse across replicas.** Ten pods of a Deployment are one
 *   workload with `runningPods: 10`, not ten workloads.
 * - **Containers collapse per `(name, digest)`, not per name.** During a
 *   rollout one container name legitimately runs two digests, and reporting a
 *   single row would hide the half of the fleet still on the old image. That
 *   state is exactly what "is the fix deployed?" reads, so the counts are per
 *   triple and do not have to sum to the workload's.
 *
 * The two attribution layers are folded in independently. A workload may carry
 * a release, an application, both or neither — and "both" is the majority case
 * on a cluster where ArgoCD renders Helm charts, so collapsing them into one
 * field would make each such workload pick a lens and discard the other.
 */
export function buildInventory(
    pods: readonly k8s.V1Pod[],
    ctx: InventoryContext = {},
): InventoryReport {
    const argocdNamespace = ctx.argocdNamespace ?? ARGOCD_NAMESPACE;
    const releases = new Map<string, InventoryRelease>();
    const applications = new Map<string, InventoryApplication>();
    const namespaces = new Map<string, InventoryNamespace>();
    // `namespace\0kind\0name` → workload, and the pod identities counted into it.
    const workloads = new Map<string, { workload: InventoryWorkload; pods: Set<string> }>();
    const containers = new Map<string, InventoryContainer>();

    for (const pod of pods) {
        const podId = `${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}`;
        for (const info of podImages(pod, ctx.owners)) {
            if (!info.digest) continue;

            let ns = namespaces.get(info.namespace);
            if (!ns) {
                // `null`, not `{}`: namespace labels need `namespaces: list`
                // RBAC the agent does not have yet, and reporting `{}` would
                // make a missing permission look like an unlabelled namespace.
                ns = { name: info.namespace, labels: null, workloads: [] };
                namespaces.set(info.namespace, ns);
            }

            const release = releaseForPod(info);
            if (release) {
                const key = releaseKey(release.namespace, release.name);
                releases.set(key, mergeRelease(releases.get(key), release));
            }

            /* The delivery layer, resolved independently of the release. The
               tracking annotation gives the app's identity; the `Application`
               object, where phase C could read one, gives the repository and
               revision — which is where an Argo user actually makes a fix. */
            const tracked = applicationForWorkload(info, argocdNamespace);
            const application = tracked
                ? ctx.applications?.get(applicationKey(tracked.namespace, tracked.name)) ?? tracked
                : null;
            if (application) {
                const key = applicationKey(application.namespace, application.name);
                applications.set(key, mergeApplication(applications.get(key), application));
            }

            /* The merged set, so `app.kubernetes.io/part-of` and the chart
               labels reach the UI even when only the controller carried them.
               Not new collection — both allowlists have already been applied. */
            const { labels } = mergedMetadata(info);

            const wKey = `${info.namespace}\u0000${info.workloadKind ?? ""}\u0000${info.workloadName}`;
            let entry = workloads.get(wKey);
            if (!entry) {
                const workload: InventoryWorkload = {
                    kind: info.workloadKind,
                    name: info.workloadName,
                    release: release ? { name: release.name, namespace: release.namespace } : null,
                    application: application
                        ? { name: application.name, namespace: application.namespace }
                        : null,
                    runningPods: 0,
                    firstStartedAt: info.startedAt?.toISOString() ?? null,
                    labels: Object.keys(labels).length > 0 ? labels : null,
                    containers: [],
                };
                entry = { workload, pods: new Set() };
                workloads.set(wKey, entry);
                ns.workloads.push(workload);
            }
            entry.pods.add(podId);

            // Earliest pod start across the replicas — how long this has been
            // running, not how long the pod we happened to see first has.
            const started = info.startedAt?.toISOString() ?? null;
            if (started && (!entry.workload.firstStartedAt || started < entry.workload.firstStartedAt)) {
                entry.workload.firstStartedAt = started;
            }

            const cKey = `${wKey}\u0000${info.containerName}\u0000${info.digest}`;
            let container = containers.get(cKey);
            if (!container) {
                const parsed = parseImageRef(info.displayName);
                container = {
                    name: info.containerName,
                    init: info.init,
                    imageRef: info.pullRef,
                    imageDigest: info.digest,
                    imageTag: parsed.tag ?? null,
                    registry: parsed.registry ?? null,
                    repository: parsed.projectName || null,
                    runningPods: 0,
                };
                containers.set(cKey, container);
                entry.workload.containers.push(container);
            }
            container.runningPods += 1;
        }
    }

    for (const { workload, pods: seen } of workloads.values()) {
        workload.runningPods = seen.size;
    }

    return {
        version: INVENTORY_VERSION,
        // Advisory only — the server stamps rows with its own clock, because
        // producer clocks skew.
        reportedAt: new Date().toISOString(),
        // Overridden by the caller when the informer has not finished its
        // initial sync; see `watch.ts`.
        informerSynced: true,
        /* `true` unless the caller says otherwise, so a producer that never
           looks — a unit test, a build over a static pod list — does not claim
           a permissions failure it did not have. `watch.ts` passes the real
           answer. */
        ownerMetadataCollected: ctx.ownerMetadataCollected ?? true,
        releases: [...releases.values()],
        applications: [...applications.values()],
        namespaces: [...namespaces.values()],
    };
}
