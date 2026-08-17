import * as k8s from "@kubernetes/client-node";
import * as fs from "fs";
import {
    validateConfig,
    API_URL,
    SCANNER_VERSION,
    CONCURRENT_SCANS,
    SKIP_EXISTING_DIGESTS,
    RESOLVE_IMAGE_PULL_SECRETS,
    RESOLVE_WORKLOAD_OWNERS,
    RESOLVE_ARGOCD_APPLICATIONS,
    ARGOCD_NAMESPACE,
    EXCLUDE_NAMESPACES,
    INCLUDE_NAMESPACES,
    EXCLUDE_IMAGES,
    shouldScan,
    shouldScanImage,
    loadKubeConfig,
    resolveRegistryAuth,
    buildTempDockerConfig,
    generateSBOM,
    Semaphore,
    podImages,
    buildInventory,
    ImageInfo,
    InventoryContext,
} from "./lib/scan.js";
import { OwnerMetadataCache } from "./lib/owner-cache.js";
import { ArgocdApplicationCache } from "./lib/argocd-applications.js";
import { heartbeat, checkExistingSbom, uploadSBOM, reportInventory } from "./lib/client.js";
import { refreshClusterVersion } from "./lib/cluster-version.js";
import { configureProxy } from "./lib/proxy.js";
import {
    HEALTH_PORT,
    INFORMER_RESTART_DELAY_MS,
    startHealthServer,
    beginInformerStart,
    markInformerUp,
    markInformerDown,
    recordInformerEvent,
} from "./lib/health.js";
import { log } from "./lib/logger.js";
import { parseImageRef } from "./parse-image-ref.js";

validateConfig();

// ─── State ───────────────────────────────────────────────────────────────────

const SEEN_DIGESTS_MAX = parseInt(process.env.SEEN_DIGESTS_MAX ?? "50000", 10);
// 6 hours default; set to 0 to disable periodic sweeps
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS ?? "21600000", 10);
// 5 minutes default; ensures scanner_last_seen_at stays fresh even when no new images appear
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "300000", 10);

// Insertion-ordered set that evicts its oldest member at capacity, so the
// scan dedup keys below cannot grow without bound.
class BoundedSet<T> {
    private map = new Map<T, undefined>();
    constructor(private maxSize: number) {}
    has(value: T): boolean { return this.map.has(value); }
    add(value: T): void {
        if (this.map.has(value)) return;
        if (this.map.size >= this.maxSize) {
            this.map.delete(this.map.keys().next().value!);
        }
        this.map.set(value, undefined);
    }
    clear(): void { this.map.clear(); }
}

const seenDigests = new BoundedSet<string>(SEEN_DIGESTS_MAX);
const sem = new Semaphore(CONCURRENT_SCANS);

// ─── Pod handler ─────────────────────────────────────────────────────────────

async function handlePod(pod: k8s.V1Pod, coreApi: k8s.CoreV1Api): Promise<void> {
    for (const info of podImages(pod)) {
        /* Keyed by the digest alone.
         *
         * It used to be `${digest}::${namespace}::${containerName}`, which made
         * the same image in five namespaces five pulls, five syft runs, five
         * component sets and five matching passes. A digest is
         * content-addressed — the bytes are identical wherever they run — so
         * scanning it once is not an optimisation, it is the correct number of
         * times. Where the image runs is reported separately, by the inventory.
         * See sbom-tracker ADR 0004. */
        if (!info.digest) continue;
        if (seenDigests.has(info.digest)) continue;
        seenDigests.add(info.digest);

        // Fire-and-forget — concurrency controlled by Semaphore
        scanImage(info, coreApi).catch((err) =>
            log.error({ image: info.displayName, err: err instanceof Error ? err.message : String(err) }, "unexpected scan error")
        );
    }
}

// ─── Inventory ───────────────────────────────────────────────────────────────

/**
 * Best-effort: a failed report costs a progress indicator, never a scan.
 *
 * Only ever called after the informer's initial list has completed, which is
 * what lets it claim `informerSynced: true`. That flag is not decoration — a
 * full-set replacement built from a half-synced informer would delete most of
 * the cluster's inventory, and the server rejects reports that admit to it.
 *
 * The two attribution lookups happen **here** rather than in `handlePod`. Both
 * describe things that change on deploy, not on pod churn, and the informer
 * calls `handlePod` on every add and update in the cluster — resolving there
 * would multiply one Deployment's `get` by its replica count and by its restart
 * rate, to learn something that was already known.
 */
async function publishInventory(
    pods: readonly k8s.V1Pod[],
    owners: OwnerMetadataCache | null,
    argocd: ArgocdApplicationCache | null,
): Promise<void> {
    /* `collected: false` when the lookup is switched off, which is the same
       thing the report says for a 403: nobody looked. The alternative — quietly
       claiming full collection — is what made the original bug invisible. */
    const resolved = owners
        ? await owners.resolve(pods)
        : { owners: undefined, collected: false };

    const ctx: InventoryContext = {
        owners: resolved.owners,
        ownerMetadataCollected: resolved.collected,
        applications: argocd ? await argocd.list() : undefined,
        argocdNamespace: ARGOCD_NAMESPACE,
    };

    const report = buildInventory(pods, ctx);
    if (report.namespaces.length === 0) {
        /* A report with no namespaces would be a request to wipe the cluster's
           inventory, and the server rejects it. A genuinely empty cluster is
           represented by *no report*, ageing out via lastSeenAt instead of
           being truncated in one step. */
        log.debug("informer sees no scannable workloads, skipping inventory report");
        return;
    }
    try {
        await reportInventory(report);
    } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "inventory report failed");
    }
}

// ─── Scan ────────────────────────────────────────────────────────────────────

async function scanImage(info: ImageInfo, coreApi: k8s.CoreV1Api): Promise<void> {
    if (SKIP_EXISTING_DIGESTS && info.digest) {
        const exists = await checkExistingSbom(info.digest);
        if (exists) {
            log.debug({ image: info.displayName, digest: info.digest }, "digest already indexed, skipping");
            return;
        }
    }

    await sem.acquire();
    let dockerConfigDir: string | undefined;
    let sbomFile: string | undefined;
    try {
        log.info({
            image: info.displayName,
            namespace: info.namespace,
            workloadKind: info.workloadKind,
            digest: info.digest,
        }, "scanning image");

        if (RESOLVE_IMAGE_PULL_SECRETS && info.imagePullSecrets.length > 0) {
            const resolved = await resolveRegistryAuth(coreApi, info.namespace, info.imagePullSecrets);
            if (Object.keys(resolved).length > 0) {
                dockerConfigDir = buildTempDockerConfig(resolved);
            }
        }

        try {
            sbomFile = await generateSBOM(info.pullRef, dockerConfigDir);
        } catch (err) {
            log.error({
                image: info.displayName,
                err: err instanceof Error ? err.message : String(err),
            }, "syft failed");
            return;
        }

        const { tag, registry, projectName: repository } = parseImageRef(info.displayName);
        try {
            await uploadSBOM(
                sbomFile,
                {
                    imageDigest: info.digest!,
                    imageRef: info.pullRef,
                    registry,
                    repository: repository || undefined,
                },
                {
                    namespace: info.namespace,
                    workloadName: info.workloadName,
                    workloadKind: info.workloadKind,
                    containerName: info.containerName,
                    imageTag: tag,
                },
            );
            log.info({ digest: info.digest, tag, namespace: info.namespace, workload: info.workloadName }, "upload succeeded");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause;
            const detail = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
            log.error({ digest: info.digest, namespace: info.namespace, err: msg, cause: detail }, "upload failed");
        }
    } finally {
        sem.release();
        if (dockerConfigDir) try { fs.rmSync(dockerConfigDir, { recursive: true }); } catch { /* ignore */ }
        if (sbomFile) try { fs.unlinkSync(sbomFile); } catch { /* ignore */ }
    }
}

// ─── Informer ────────────────────────────────────────────────────────────────

/**
 * Starts (or restarts) the informer and records whether it is watching.
 *
 * Not a bare `informer.start()`: the call resolves even when the initial list
 * fails, because the informer reports that by emitting 'error' rather than by
 * rejecting. `beginInformerStart` / `markInformerUp` bracket the attempt so an
 * error arriving in between is not mistaken for a recovery — otherwise every
 * failed restart would look like a healthy one. See `lib/health.ts`.
 */
async function startInformer(informer: k8s.Informer<k8s.V1Pod>): Promise<void> {
    const attempt = beginInformerStart();
    await informer.start();
    if (markInformerUp(attempt)) {
        log.info("watching for pod changes across all namespaces");
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log.info({
        apiUrl: API_URL,
        scannerVersion: SCANNER_VERSION,
        excludeNamespaces: [...EXCLUDE_NAMESPACES],
        includeNamespaces: INCLUDE_NAMESPACES ? [...INCLUDE_NAMESPACES] : undefined,
        excludeImages: EXCLUDE_IMAGES,
        concurrentScans: CONCURRENT_SCANS,
        skipExistingDigests: SKIP_EXISTING_DIGESTS,
        resolveImagePullSecrets: RESOLVE_IMAGE_PULL_SECRETS,
        resolveWorkloadOwners: RESOLVE_WORKLOAD_OWNERS,
        resolveArgocdApplications: RESOLVE_ARGOCD_APPLICATIONS,
        argocdNamespace: RESOLVE_ARGOCD_APPLICATIONS ? ARGOCD_NAMESPACE : undefined,
        sweepIntervalMs: SWEEP_INTERVAL_MS || "disabled",
        healthPort: HEALTH_PORT,
    }, "StackRadar cluster watcher starting");

    // Before the first heartbeat: in a cluster with no direct egress, every
    // request below this line has to go through the proxy or fail.
    configureProxy();

    // Before anything that can be slow. The kubelet starts probing on its own
    // schedule, and an initial sync that takes a minute in a large cluster
    // must answer "not ready yet" rather than "connection refused" — the
    // latter is indistinguishable from a crash loop.
    await startHealthServer();

    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    /* Built once and kept: both memoise across reports, which is what keeps a
       500-pod cluster at one `get` per controller for the life of the process
       rather than one per report. `null` when switched off — a distinct state
       from "resolved nothing", and the one the report tells the server about. */
    const owners = RESOLVE_WORKLOAD_OWNERS ? new OwnerMetadataCache(kc) : null;
    const argocd = RESOLVE_ARGOCD_APPLICATIONS
        ? new ArgocdApplicationCache(kc, ARGOCD_NAMESPACE)
        : null;

    // Before the first heartbeat, so it can carry the version; a failed read
    // logs and the heartbeat goes out without the header.
    await refreshClusterVersion(kc);
    await heartbeat();

    const informer = k8s.makeInformer(
        kc,
        "/api/v1/pods",
        () => coreApi.listPodForAllNamespaces(),
    );

    informer.on("add", (pod: k8s.V1Pod) => {
        recordInformerEvent();
        handlePod(pod, coreApi).catch((err) =>
            log.error({ err: err instanceof Error ? err.message : String(err) }, "error handling pod add")
        );
    });

    informer.on("update", (pod: k8s.V1Pod) => {
        recordInformerEvent();
        handlePod(pod, coreApi).catch((err) =>
            log.error({ err: err instanceof Error ? err.message : String(err) }, "error handling pod update")
        );
    });

    informer.on("error", (err: Error) => {
        markInformerDown();
        log.error(
            { err: err.message, restartInMs: INFORMER_RESTART_DELAY_MS },
            "informer error, restarting"
        );
        setTimeout(() => {
            startInformer(informer).catch((e) =>
                log.error({ err: e instanceof Error ? e.message : String(e) }, "failed to restart informer")
            );
        }, INFORMER_RESTART_DELAY_MS);
    });

    await startInformer(informer);

    /* The informer's initial list has completed by the time `start()` resolves,
       so its cache is the whole cluster. Reporting it here is what turns the
       first minutes — image pull plus syft, before any SBOM exists — from a
       blank screen into a count that fills in. */
    await publishInventory(informer.list(), owners, argocd);

    setInterval(() => {
        // Refresh first — control planes upgrade underneath long-lived
        // agents — then let the heartbeat carry whatever is last known.
        refreshClusterVersion(kc)
            .then(() => heartbeat())
            .catch((err) =>
                log.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat failed")
            );
        // Same cadence, because the report is a full set replacement and this
        // is how a scaled-down or deleted workload leaves the inventory.
        void publishInventory(informer.list(), owners, argocd);
    }, HEARTBEAT_INTERVAL_MS);

    if (SWEEP_INTERVAL_MS > 0) {
        setInterval(async () => {
            log.info("starting periodic sweep");
            seenDigests.clear();
            try {
                const res = await coreApi.listPodForAllNamespaces();
                for (const pod of res.items) {
                    await handlePod(pod, coreApi).catch((err) =>
                        log.error({ err: err instanceof Error ? err.message : String(err) }, "error handling pod in sweep")
                    );
                }
                log.info("periodic sweep complete");
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : String(err) }, "periodic sweep failed");
            }
        }, SWEEP_INTERVAL_MS);
    }

    // Keep the process alive; the informer drives all work via events.
    await new Promise<never>(() => {});
}

main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal error");
    process.exit(1);
});
