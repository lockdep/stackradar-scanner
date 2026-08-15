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
export function podImages(pod: k8s.V1Pod): ImageInfo[] {
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
            imagePullSecrets: pullSecrets,
        });
    }

    return images;
}

// ─── Inventory ───────────────────────────────────────────────────────────────

/**
 * The `POST /v1/inventory` v2 payload.
 *
 * Derived from `sbom-tracker/docs/contracts/inventory-v2.md`, which is the
 * shared definition both repos encode. Change the contract first.
 */

export const INVENTORY_VERSION = 2;

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
    release: { name: string; namespace: string } | null;
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

export interface InventoryRelease {
    name: string;
    /** The **release's** own namespace, from `meta.helm.sh/release-namespace`. */
    namespace: string;
    chartName: string | null;
    chartVersion: string | null;
    appVersion: string | null;
    /** Always `null` today — pod metadata cannot supply it. See phase 3. */
    repoUrl: string | null;
    source: "helm";
}

export interface InventoryReport {
    version: number;
    reportedAt: string;
    informerSynced: boolean;
    releases: InventoryRelease[];
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
 * The Helm release a pod belongs to.
 *
 * **Read from labels, not from `meta.helm.sh/release-*`.** Helm writes those
 * annotations onto the objects it manages directly — the Deployment, the
 * StatefulSet — and nothing propagates them to the pod template, so on a real
 * cluster no pod carries them and an annotation-gated check finds zero releases
 * everywhere. Worse, a chart applied by ArgoCD or Flux has them on nothing at
 * all: the renderer is Helm but the installer is not, and only the labels
 * survive that hand-off.
 *
 * What does reach the pod is the standard label set every chart templates into
 * `spec.template.metadata.labels`: `app.kubernetes.io/instance` is the release
 * name and `helm.sh/chart` is `<chart>-<version>`. The annotations are still
 * honoured first where they do appear — a bare pod `helm install`ed on its own
 * has them, and they are the only source that can name a release living in a
 * *different* namespace than the workload.
 */
function releaseForPod(info: ImageInfo): InventoryRelease | null {
    /* Authoritative when present, which is rare: Helm wrote it, so both the
       name and the release's own namespace are facts rather than inferences. */
    const annotatedName = info.podAnnotations["meta.helm.sh/release-name"];
    const annotatedNamespace = info.podAnnotations["meta.helm.sh/release-namespace"];

    /* `app.kubernetes.io/managed-by` names the controller that owns the object.
       When something other than Helm claims it, `instance` is that controller's
       grouping key and not a release name — prometheus-operator stamps
       `instance: kube-prometheus-stack-alertmanager` on pods of a StatefulSet
       it generated itself, and trusting it would invent a release that no
       `helm list` will ever show. */
    const managedBy = info.podLabels["app.kubernetes.io/managed-by"] ?? info.podLabels["heritage"];
    if (!annotatedName && managedBy && managedBy.toLowerCase() !== "helm") return null;

    const name =
        annotatedName ??
        info.podLabels["app.kubernetes.io/instance"] ??
        info.podLabels["release"];
    if (!name) return null;

    /* The *release's* namespace, not the workload's — a chart may deploy
       resources into other namespaces, and keying on the workload's namespace
       silently splits one release into several. Only the annotation can tell
       them apart; with labels alone the workload's namespace is the honest
       best answer, and it is right for every single-namespace release. */
    const namespace = annotatedNamespace ?? info.namespace;

    const { chartName, chartVersion } = parseHelmChartLabel(
        info.podLabels["helm.sh/chart"] ?? info.podLabels["chart"]
    );

    return {
        name,
        namespace,
        chartName,
        chartVersion,
        appVersion: info.podLabels["app.kubernetes.io/version"] ?? null,
        // Pod metadata cannot supply it, and `null` means unknown rather than
        // "no repo". Without it, fleet-wide "all releases of chart X" is a name
        // match — see phase 3.
        repoUrl: null,
        source: "helm",
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

const releaseKey = (namespace: string, name: string) => `${namespace}\u0000${name}`;

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
 */
export function buildInventory(pods: readonly k8s.V1Pod[]): InventoryReport {
    const releases = new Map<string, InventoryRelease>();
    const namespaces = new Map<string, InventoryNamespace>();
    // `namespace\0kind\0name` → workload, and the pod identities counted into it.
    const workloads = new Map<string, { workload: InventoryWorkload; pods: Set<string> }>();
    const containers = new Map<string, InventoryContainer>();

    for (const pod of pods) {
        const podId = `${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}`;
        for (const info of podImages(pod)) {
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

            const wKey = `${info.namespace}\u0000${info.workloadKind ?? ""}\u0000${info.workloadName}`;
            let entry = workloads.get(wKey);
            if (!entry) {
                const workload: InventoryWorkload = {
                    kind: info.workloadKind,
                    name: info.workloadName,
                    release: release ? { name: release.name, namespace: release.namespace } : null,
                    runningPods: 0,
                    firstStartedAt: info.startedAt?.toISOString() ?? null,
                    labels: Object.keys(info.podLabels).length > 0 ? info.podLabels : null,
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
        releases: [...releases.values()],
        namespaces: [...namespaces.values()],
    };
}
