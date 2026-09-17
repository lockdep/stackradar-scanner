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
    attachImageMetadata,
    Semaphore,
    podImages,
    buildInventory,
    ImageInfo,
    InventoryContext,
} from "./lib/scan.js";
import { OwnerMetadataCache } from "./lib/owner-cache.js";
import { ArgocdApplicationCache } from "./lib/argocd-applications.js";
import {
    heartbeat,
    checkExistingSbom,
    uploadSBOM,
    reportInventory,
    HeartbeatRejectedError,
    UploadRejectedError,
} from "./lib/client.js";
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
import { classifyScanFailure, type ScanFailure } from "./lib/scan-failure.js";
import { parseImageRef } from "./parse-image-ref.js";

validateConfig();

// ─── State ───────────────────────────────────────────────────────────────────

const SEEN_DIGESTS_MAX = parseInt(process.env.SEEN_DIGESTS_MAX ?? "50000", 10);
// 6 hours default; set to 0 to disable periodic sweeps
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS ?? "21600000", 10);
// 5 minutes default; ensures scanner_last_seen_at stays fresh even when no new images appear
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "300000", 10);
// How long a digest whose scan failed for a transient reason stays out of the
// queue before the next pod event may try it again. Without a cooldown a
// crash-looping pod emits an update every few seconds, and each would re-pull
// the image the registry just refused.
const SCAN_RETRY_COOLDOWN_MS = parseInt(process.env.SCAN_RETRY_COOLDOWN_MS ?? "300000", 10);
// Upper bound on the pause between startup heartbeat attempts. Only a
// credential failure is fatal; everything else is the control plane being
// deployed, and the agent waits for it rather than crash-looping the fleet.
const STARTUP_HEARTBEAT_MAX_BACKOFF_MS = 60_000;
const STARTUP_HEARTBEAT_ATTEMPTS = 6;
// Grace the chart gives us (terminationGracePeriodSeconds), minus a margin so
// the process exits on its own terms rather than by SIGKILL.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "25000", 10);

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
    delete(value: T): void { this.map.delete(value); }
    clear(): void { this.map.clear(); }
}

const seenDigests = new BoundedSet<string>(SEEN_DIGESTS_MAX);
const sem = new Semaphore(CONCURRENT_SCANS);

/**
 * Why the last scan of a digest failed, keyed by digest — the memory behind
 * the report's `scanFailures`. Display-only by contract: nothing here feeds
 * retry decisions. An entry leaves three ways: the scan succeeds, the digest
 * stops appearing in inventory reports (pruned in `publishInventory`), or a
 * pathological cluster overflows the same bound `seenDigests` has.
 */
const scanFailures = new Map<string, ScanFailure>();

function recordScanFailure(info: ImageInfo, stderr: string): ScanFailure {
    const failure: ScanFailure = {
        imageDigest: info.digest!,
        code: classifyScanFailure(stderr),
        registryHost: parseImageRef(info.displayName).registry ?? null,
    };
    if (scanFailures.size >= SEEN_DIGESTS_MAX && !scanFailures.has(failure.imageDigest)) {
        scanFailures.delete(scanFailures.keys().next().value!);
    }
    scanFailures.set(failure.imageDigest, failure);
    return failure;
}

/** Scans in flight, so shutdown can wait for them. */
let inFlightScans = 0;
let shuttingDown = false;

/**
 * Lets the next pod event for this digest try again, after a cooldown.
 *
 * The digest enters `seenDigests` *before* its scan so two events for the same
 * image cannot race into two pulls; the cost was that a failed scan stuck
 * there until the six-hour sweep. A transient failure — registry 5xx, syft
 * timeout, control plane mid-deploy — now frees the slot instead. A permanent
 * one (a 400 on upload, an image that does not exist) stays, because retrying
 * it would only repeat the same log line.
 */
function requeueAfterCooldown(digest: string): void {
    const timer = setTimeout(() => seenDigests.delete(digest), SCAN_RETRY_COOLDOWN_MS);
    timer.unref();
}

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
        if (shuttingDown) continue;
        if (seenDigests.has(info.digest)) continue;
        seenDigests.add(info.digest);

        // Fire-and-forget — concurrency controlled by Semaphore
        const digest = info.digest;
        scanImage(info, coreApi)
            .then((outcome) => {
                if (outcome === "retry") requeueAfterCooldown(digest);
            })
            .catch((err) => {
                log.error({ image: info.displayName, err: err instanceof Error ? err.message : String(err) }, "unexpected scan error");
                requeueAfterCooldown(digest);
            });
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
        scanFailures: [...scanFailures.values()],
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
    /* The build filtered `scanFailures` to digests the report carries; prune
       the memory to the same set. A digest that left the cluster and comes
       back re-records itself on its next failed scan, so nothing is lost —
       and without the prune, failures for long-gone images accumulate for the
       life of the process. */
    const stillReported = new Set((report.scanFailures ?? []).map((f) => f.imageDigest));
    for (const digest of [...scanFailures.keys()]) {
        if (!stillReported.has(digest)) scanFailures.delete(digest);
    }

    try {
        await reportInventory(report);
    } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "inventory report failed");
    }
}

// ─── Scan ────────────────────────────────────────────────────────────────────

/** What `handlePod` does with the digest afterwards. */
type ScanOutcome = "done" | "retry";

async function scanImage(info: ImageInfo, coreApi: k8s.CoreV1Api): Promise<ScanOutcome> {
    /* Behind the semaphore, not in front of it. The check is one request per
       digest, and on a cold start a large cluster has thousands of digests
       arriving in the same second — in front of the semaphore that was
       thousands of concurrent requests to a control plane that had just asked
       us, via 429, to slow down. */
    await sem.acquire();
    inFlightScans++;
    let dockerConfigDir: string | undefined;
    let sbomFile: string | undefined;
    try {
        if (shuttingDown) return "retry";

        if (SKIP_EXISTING_DIGESTS) {
            const check = await checkExistingSbom(info.digest!);
            if (check === "exists") {
                // An SBOM landed for this digest — whatever failure we
                // remember predates it and must stop being reported.
                scanFailures.delete(info.digest!);
                log.debug({ image: info.displayName, digest: info.digest }, "digest already indexed, skipping");
                return "done";
            }
            if (check === "unknown") {
                /* Not "scan anyway": a rate-limited or unreachable control
                   plane would then be handed a pull, a syft run and an upload
                   for every image in the cluster at the moment it could least
                   take them. Ask again after the cooldown. */
                log.info({ image: info.displayName, digest: info.digest }, "control plane unavailable for digest check, deferring scan");
                return "retry";
            }
        }

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
            const generated = await generateSBOM(info.pullRef, dockerConfigDir);
            sbomFile = generated.sbomFile;
            const attached = attachImageMetadata(generated);
            log.debug({ image: info.displayName, properties: attached }, "image metadata attached");
            // The scan works again; the remembered failure is over. The
            // server-side columns clear on the *upload*, not here — this only
            // stops the next inventory from re-asserting a stale failure.
            scanFailures.delete(info.digest!);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const failure = recordScanFailure(info, msg);
            log.error({ image: info.displayName, code: failure.code, err: msg }, "syft failed");
            /* syft cannot tell us whether the registry said 401 or 503 in a
               form worth parsing *for control flow*, so every syft failure is
               retried once the cooldown passes — a wrong credential costs one
               more pull attempt per cooldown, a flaky registry costs nothing.
               A SIGTERM mid-pull is the one case that is certainly not the
               image's fault. The classification above is display-only: it
               rides the next inventory report so the coverage card can say
               *why*, and it never changes what is retried. */
            return "retry";
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
            return "done";
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause;
            const detail = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
            log.error({ digest: info.digest, namespace: info.namespace, err: msg, cause: detail }, "upload failed");
            // A 4xx other than 429 is about this SBOM; everything else is
            // about this minute.
            return err instanceof UploadRejectedError && !err.retryable ? "done" : "retry";
        }
    } finally {
        inFlightScans--;
        sem.release();
        if (dockerConfigDir) try { fs.rmSync(dockerConfigDir, { recursive: true }); } catch { /* ignore */ }
        if (sbomFile) try { fs.unlinkSync(sbomFile); } catch { /* ignore */ }
    }
}

// ─── Startup heartbeat ───────────────────────────────────────────────────────

/**
 * The first heartbeat, with the one policy that matters for a fleet: only a
 * credential failure is fatal.
 *
 * It used to be "any non-2xx is fatal", which meant a StackRadar deploy — a
 * minute of 502s from the ingress — put every customer cluster's scanner into
 * CrashLoopBackOff at once, and a backoff that grew to five minutes before the
 * control plane was even back. A 401 or 403 cannot be fixed by waiting, and
 * exiting is what makes it visible in `kubectl get pods`; a 5xx or a network
 * error is waited out with capped backoff, and if it is still failing after
 * the last attempt the agent starts anyway. The periodic heartbeat keeps
 * trying, `/healthz` reports the failures, and the scans that cannot upload
 * are requeued rather than lost.
 */
async function startupHeartbeat(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await heartbeat();
            return;
        } catch (err) {
            if (err instanceof HeartbeatRejectedError && err.isAuthFailure) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt >= STARTUP_HEARTBEAT_ATTEMPTS) {
                log.warn({ err: msg, attempts: attempt }, "control plane unreachable at startup; starting anyway and retrying on the heartbeat interval");
                return;
            }
            const backoffMs = Math.min(STARTUP_HEARTBEAT_MAX_BACKOFF_MS, 2000 * 2 ** (attempt - 1));
            log.warn({ err: msg, attempt, backoffMs }, "startup heartbeat failed, retrying");
            await new Promise((r) => setTimeout(r, backoffMs));
        }
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
    await startupHeartbeat();

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
        publishInventory(informer.list(), owners, argocd).catch((err) =>
            log.error({ err: err instanceof Error ? err.message : String(err) }, "inventory publish failed")
        );
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

    installShutdownHandlers(informer);

    // Keep the process alive; the informer drives all work via events.
    await new Promise<never>(() => {});
}

// ─── Shutdown ────────────────────────────────────────────────────────────────

/**
 * Exit on SIGTERM instead of being SIGKILLed at the end of the grace period.
 *
 * Node is PID 1 in the image, and PID 1 gets no default signal handling from
 * the kernel: without a handler SIGTERM is simply dropped, every rollout waits
 * the full `terminationGracePeriodSeconds`, and then the kubelet kills syft
 * mid-pull with a half-written temp file. With one, the agent stops taking new
 * work, lets in-flight scans finish inside the grace period, and exits 0.
 * Whatever did not finish is not lost — it is unscanned, and the replacement
 * pod's initial list picks it up.
 */
function installShutdownHandlers(informer: k8s.Informer<k8s.V1Pod>): void {
    const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) return;
        shuttingDown = true;
        markInformerDown();
        log.info({ signal, inFlightScans }, "shutting down");
        informer.stop().catch(() => { /* already stopping */ });

        const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
        const poll = setInterval(() => {
            if (inFlightScans === 0 || Date.now() >= deadline) {
                clearInterval(poll);
                if (inFlightScans > 0) {
                    log.warn({ inFlightScans }, "shutdown deadline reached with scans in flight; they will be redone by the next pod");
                }
                process.exit(0);
            }
        }, 200);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
}

main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal error");
    process.exit(1);
});
