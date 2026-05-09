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
    shouldScan,
    pickPodLabels,
    pickPodAnnotations,
    deriveWorkloadName,
    resolveRegistryAuth,
    buildTempDockerConfig,
    generateSBOM,
    uploadSBOM,
    checkExistingSbom,
    Semaphore,
    ImageInfo,
} from "./lib/scan.js";
import { log } from "./lib/logger.js";
import { parseImageRef } from "./parse-image-ref.js";

validateConfig();

// ─── State ───────────────────────────────────────────────────────────────────

const SEEN_DIGESTS_MAX = parseInt(process.env.SEEN_DIGESTS_MAX ?? "50000", 10);
// 6 hours default; set to 0 to disable periodic sweeps
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS ?? "21600000", 10);

// Keyed by `${digest}::${namespace}::${containerName}` to avoid re-scanning
// the same running container across informer re-syncs or pod restarts with
// the same image binary. Bounded to prevent unbounded memory growth.
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
    const namespace = pod.metadata?.namespace ?? "default";
    if (!shouldScan(namespace)) return;

    const phase = pod.status?.phase;
    if (phase !== "Running" && phase !== "Succeeded" && phase !== "Failed") return;

    const allStatuses = [
        ...(pod.status?.containerStatuses ?? []),
        ...(pod.status?.initContainerStatuses ?? []),
    ];

    for (const cs of allStatuses) {
        const isActive = cs.state?.running || cs.state?.terminated;
        if (!cs.imageID || !isActive) continue;

        const normalized = cs.imageID.replace(/^docker-pullable:\/\//, "");
        const digestMatch = normalized.match(/sha256:[a-f0-9]{64}/);
        if (!digestMatch) continue;
        const digest = digestMatch[0];

        const dedupKey = `${digest}::${namespace}::${cs.name}`;
        if (seenDigests.has(dedupKey)) continue;
        seenDigests.add(dedupKey);

        const pullRef = normalized.includes("@sha256:")
            ? normalized
            : `${cs.image}@${digest}`;

        const rawLabels = pod.metadata?.labels;
        const workloadName = deriveWorkloadName(pod.metadata?.name ?? "", rawLabels);
        const pullSecrets = (pod.spec?.imagePullSecrets ?? [])
            .map((s) => s.name)
            .filter((n): n is string => Boolean(n));

        const info: ImageInfo = {
            pullRef,
            displayName: cs.image ?? pullRef,
            digest,
            namespace,
            workloadName,
            containerName: cs.name ?? workloadName,
            workloadKind: "Pod",
            podLabels: pickPodLabels(rawLabels),
            podAnnotations: pickPodAnnotations(pod.metadata?.annotations),
            imagePullSecrets: pullSecrets,
        };

        // Fire-and-forget — concurrency controlled by Semaphore
        scanImage(info, coreApi).catch((err) =>
            log.error({ image: info.displayName, err: err instanceof Error ? err.message : String(err) }, "unexpected scan error")
        );
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
            sbomFile = generateSBOM(info.pullRef, dockerConfigDir);
        } catch (err) {
            log.error({
                image: info.displayName,
                err: err instanceof Error ? err.message : String(err),
            }, "syft failed");
            return;
        }

        const { version, registry } = parseImageRef(info.displayName);
        const projectName = `${info.workloadName}/${info.containerName}`;
        try {
            await uploadSBOM(sbomFile, projectName, version, info.namespace, registry, info.digest, info.pullRef, info.workloadKind, info.podLabels, info.podAnnotations);
            log.info({ projectName, version, namespace: info.namespace }, "upload succeeded");
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log.info({
        apiUrl: API_URL,
        scannerVersion: SCANNER_VERSION,
        excludeNamespaces: [...EXCLUDE_NAMESPACES],
        includeNamespaces: INCLUDE_NAMESPACES ? [...INCLUDE_NAMESPACES] : undefined,
        concurrentScans: CONCURRENT_SCANS,
        skipExistingDigests: SKIP_EXISTING_DIGESTS,
        resolveImagePullSecrets: RESOLVE_IMAGE_PULL_SECRETS,
        sweepIntervalMs: SWEEP_INTERVAL_MS || "disabled",
    }, "StackRadar cluster watcher starting");

    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const informer = k8s.makeInformer(
        kc,
        "/api/v1/pods",
        () => coreApi.listPodForAllNamespaces(),
    );

    informer.on("add", (pod: k8s.V1Pod) => {
        handlePod(pod, coreApi).catch((err) =>
            log.error({ err: err instanceof Error ? err.message : String(err) }, "error handling pod add")
        );
    });

    informer.on("update", (pod: k8s.V1Pod) => {
        handlePod(pod, coreApi).catch((err) =>
            log.error({ err: err instanceof Error ? err.message : String(err) }, "error handling pod update")
        );
    });

    informer.on("error", (err: Error) => {
        log.error({ err: err.message }, "informer error, restarting in 5s");
        setTimeout(() => {
            informer.start().catch((e) =>
                log.error({ err: e instanceof Error ? e.message : String(e) }, "failed to restart informer")
            );
        }, 5000);
    });

    await informer.start();
    log.info("watching for pod changes across all namespaces");

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
