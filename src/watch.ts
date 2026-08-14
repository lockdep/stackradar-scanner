import * as k8s from "@kubernetes/client-node";
import * as fs from "fs";
import {
    validateConfig,
    API_URL,
    SCANNER_VERSION,
    CONCURRENT_SCANS,
    SKIP_EXISTING_DIGESTS,
    RESOLVE_IMAGE_PULL_SECRETS,
    EXCLUDE_NAMESPACES,
    INCLUDE_NAMESPACES,
    EXCLUDE_IMAGES,
    shouldScan,
    shouldScanImage,
    pickPodLabels,
    pickPodAnnotations,
    deriveWorkloadName,
    loadKubeConfig,
    resolveRegistryAuth,
    buildTempDockerConfig,
    generateSBOM,
    Semaphore,
    podImages,
    buildInventory,
    ImageInfo,
} from "./lib/scan.js";
import { heartbeat, checkExistingSbom, uploadSBOM, reportInventory } from "./lib/client.js";
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
        // Keyed by `${digest}::${namespace}::${containerName}` to avoid
        // re-scanning the same running container across informer re-syncs or
        // pod restarts with the same image binary.
        const dedupKey = `${info.digest}::${info.namespace}::${info.containerName}`;
        if (seenDigests.has(dedupKey)) continue;
        seenDigests.add(dedupKey);

        // Fire-and-forget — concurrency controlled by Semaphore
        scanImage(info, coreApi).catch((err) =>
            log.error({ image: info.displayName, err: err instanceof Error ? err.message : String(err) }, "unexpected scan error")
        );
    }
}

// ─── Inventory ───────────────────────────────────────────────────────────────

/** Best-effort: a failed report costs a progress indicator, never a scan. */
async function publishInventory(pods: readonly k8s.V1Pod[]): Promise<void> {
    try {
        await reportInventory(buildInventory(pods));
    } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "inventory report failed");
    }
}

// ─── Scan ────────────────────────────────────────────────────────────────────

async function scanImage(info: ImageInfo, coreApi: k8s.CoreV1Api): Promise<void> {
    if (SKIP_EXISTING_DIGESTS && info.digest) {
        const projectName = `${info.workloadName}/${info.containerName}`;
        const exists = await checkExistingSbom(info.digest, projectName, info.namespace);
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

        const { tag, registry } = parseImageRef(info.displayName);
        const projectName = `${info.workloadName}/${info.containerName}`;
        try {
            await uploadSBOM(sbomFile, projectName, tag, info.namespace, registry, info.digest, info.pullRef, info.workloadKind, info.podLabels, info.podAnnotations);
            log.info({ projectName, tag, namespace: info.namespace }, "upload succeeded");
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause;
            const detail = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
            log.error({ projectName, namespace: info.namespace, err: msg, cause: detail }, "upload failed");
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
    await publishInventory(informer.list());

    setInterval(() => {
        heartbeat().catch((err) =>
            log.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat failed")
        );
        // Same cadence, because the report is a full set replacement and this
        // is how a scaled-down or deleted workload leaves the inventory.
        void publishInventory(informer.list());
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
