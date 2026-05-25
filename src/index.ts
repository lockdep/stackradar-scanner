import * as k8s from "@kubernetes/client-node";
import * as fs from "fs";
import {
    validateConfig,
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
    Semaphore,
    ImageInfo,
} from "./lib/scan.js";
import { heartbeat, checkExistingSbom, uploadSBOM } from "./lib/client.js";
import { log } from "./lib/logger.js";
import { parseImageRef } from "./parse-image-ref.js";

validateConfig();

// ─── Image discovery ─────────────────────────────────────────────────────────

/**
 * Discovers all images the cluster is configured to run by scanning workload
 * resources (Deployments, StatefulSets, DaemonSets, CronJobs), then enriches
 * entries with digest data from any currently running pods.
 *
 * Phase 1: Workload specs  → tag-based image references (always present)
 * Phase 2: Running pods    → sha256 digest enrichment (when available)
 */
async function discoverImages(
    coreApi: k8s.CoreV1Api,
    appsApi: k8s.AppsV1Api,
    batchApi: k8s.BatchV1Api,
): Promise<Map<string, ImageInfo>> {
    const imageMap = new Map<string, ImageInfo>();

    // ── Phase 1: Collect images from workload specs ──────────────────────

    const [deployments, statefulSets, daemonSets, cronJobs, jobs] = await Promise.all([
        appsApi.listDeploymentForAllNamespaces(),
        appsApi.listStatefulSetForAllNamespaces(),
        appsApi.listDaemonSetForAllNamespaces(),
        batchApi.listCronJobForAllNamespaces(),
        batchApi.listJobForAllNamespaces(),
    ]);

    function addFromPodTemplate(
        namespace: string,
        workloadName: string,
        workloadKind: string,
        template: k8s.V1PodTemplateSpec,
        workloadAnnotations: Record<string, string> | undefined,
    ): void {
        const containers = template.spec?.containers ?? [];
        const initContainers = template.spec?.initContainers ?? [];
        const labels = pickPodLabels(template.metadata?.labels);
        // Helm and ArgoCD typically write `meta.helm.sh/release-*` and
        // `argocd.argoproj.io/tracking-id` on the workload object itself,
        // not on the pod template, so prefer workload-level annotations and
        // fall back to template-level for anything missing.
        const annotations = {
            ...pickPodAnnotations(template.metadata?.annotations),
            ...pickPodAnnotations(workloadAnnotations),
        };
        const pullSecrets = (template.spec?.imagePullSecrets ?? [])
            .map((s) => s.name)
            .filter((n): n is string => Boolean(n));

        for (const c of [...containers, ...initContainers]) {
            if (!c.image) continue;
            const key = `${c.image}::${namespace}`;
            if (imageMap.has(key)) continue;

            imageMap.set(key, {
                pullRef: c.image,
                displayName: c.image,
                digest: undefined,
                namespace,
                workloadName,
                containerName: c.name ?? c.image,
                workloadKind,
                podLabels: labels,
                podAnnotations: annotations,
                imagePullSecrets: pullSecrets,
            });
        }
    }

    for (const d of deployments.items) {
        const ns = d.metadata?.namespace ?? "default";
        if (!shouldScan(ns)) continue;
        if (d.spec?.template) {
            addFromPodTemplate(ns, d.metadata?.name ?? "unknown", "Deployment", d.spec.template, d.metadata?.annotations);
        }
    }

    for (const ss of statefulSets.items) {
        const ns = ss.metadata?.namespace ?? "default";
        if (!shouldScan(ns)) continue;
        if (ss.spec?.template) {
            addFromPodTemplate(ns, ss.metadata?.name ?? "unknown", "StatefulSet", ss.spec.template, ss.metadata?.annotations);
        }
    }

    for (const ds of daemonSets.items) {
        const ns = ds.metadata?.namespace ?? "default";
        if (!shouldScan(ns)) continue;
        if (ds.spec?.template) {
            addFromPodTemplate(ns, ds.metadata?.name ?? "unknown", "DaemonSet", ds.spec.template, ds.metadata?.annotations);
        }
    }

    for (const cj of cronJobs.items) {
        const ns = cj.metadata?.namespace ?? "default";
        if (!shouldScan(ns)) continue;
        const template = cj.spec?.jobTemplate?.spec?.template;
        if (template) {
            addFromPodTemplate(ns, cj.metadata?.name ?? "unknown", "CronJob", template, cj.metadata?.annotations);
        }
    }

    for (const job of jobs.items) {
        const ns = job.metadata?.namespace ?? "default";
        if (!shouldScan(ns)) continue;
        const template = job.spec?.template;
        if (!template) continue;

        // Roll Jobs owned by a CronJob up under the CronJob's stable name.
        // Otherwise each CronJob run produces a uniquely-named Job (e.g.
        // "my-cron-29605320") which would create a new project per run.
        const cronOwner = job.metadata?.ownerReferences?.find(
            (o) => o.kind === "CronJob" && o.controller === true,
        );
        if (cronOwner?.name) {
            addFromPodTemplate(ns, cronOwner.name, "CronJob", template, job.metadata?.annotations);
        } else {
            addFromPodTemplate(ns, job.metadata?.name ?? "unknown", "Job", template, job.metadata?.annotations);
        }
    }

    // ── Phase 2: Enrich with digest data from running/completed pods ─────

    const podList = await coreApi.listPodForAllNamespaces();

    for (const pod of podList.items) {
        const namespace = pod.metadata?.namespace ?? "default";
        if (!shouldScan(namespace)) continue;

        const phase = pod.status?.phase;
        if (phase !== "Running" && phase !== "Succeeded" && phase !== "Failed") continue;

        const allContainerStatuses = [
            ...(pod.status?.containerStatuses ?? []),
            ...(pod.status?.initContainerStatuses ?? []),
        ];

        for (const cs of allContainerStatuses) {
            const isActive = cs.state?.running || cs.state?.terminated;
            if (!cs.imageID || !isActive) continue;

            const normalized = cs.imageID.replace(/^docker-pullable:\/\//, "");
            const digestMatch = normalized.match(/sha256:[a-f0-9]{64}/);
            if (!digestMatch) continue;
            const digest = digestMatch[0];

            const pullRef = normalized.includes("@sha256:")
                ? normalized
                : `${cs.image}@${digest}`;

            const key = `${cs.image}::${namespace}`;
            const existing = imageMap.get(key);

            if (existing) {
                if (!existing.digest) {
                    existing.digest = digest;
                    existing.pullRef = pullRef;
                }
                Object.assign(existing.podLabels, pickPodLabels(pod.metadata?.labels));
                Object.assign(existing.podAnnotations, pickPodAnnotations(pod.metadata?.annotations));
            } else {
                const rawLabels = pod.metadata?.labels;
                const workloadName = deriveWorkloadName(pod.metadata?.name ?? "", rawLabels);
                imageMap.set(key, {
                    pullRef,
                    displayName: cs.image ?? pullRef,
                    digest,
                    namespace,
                    workloadName,
                    containerName: cs.name ?? workloadName,
                    workloadKind: "Pod",
                    podLabels: pickPodLabels(rawLabels),
                    podAnnotations: pickPodAnnotations(pod.metadata?.annotations),
                    imagePullSecrets: [],
                });
            }
        }
    }

    return imageMap;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log.info({
        scannerVersion: SCANNER_VERSION,
        excludeNamespaces: [...EXCLUDE_NAMESPACES],
        includeNamespaces: INCLUDE_NAMESPACES ? [...INCLUDE_NAMESPACES] : undefined,
        concurrentScans: CONCURRENT_SCANS,
        skipExistingDigests: SKIP_EXISTING_DIGESTS,
        resolveImagePullSecrets: RESOLVE_IMAGE_PULL_SECRETS,
    }, "StackRadar cluster scanner starting");

    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
    const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
    const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);

    await heartbeat();

    log.info("discovering images from workload resources and running pods");
    const images = await discoverImages(coreV1Api, appsV1Api, batchV1Api);
    log.info({ imageCount: images.size }, "image discovery complete");

    for (const info of images.values()) {
        log.debug({
            image: info.displayName,
            namespace: info.namespace,
            workloadKind: info.workloadKind,
            hasDigest: !!info.digest,
        }, "discovered image");
    }

    if (images.size === 0) {
        log.info("nothing to scan");
        return;
    }

    let succeeded = 0;
    let failed = 0;

    // Group entries so syft runs once per unique image binary.
    const bySyftKey = new Map<string, ImageInfo[]>();
    for (const info of images.values()) {
        const groupKey = info.digest ?? info.pullRef;
        const group = bySyftKey.get(groupKey) ?? [];
        group.push(info);
        bySyftKey.set(groupKey, group);
    }

    const sem = new Semaphore(CONCURRENT_SCANS);

    await Promise.all(
        [...bySyftKey.values()].map(async (entries) => {
            const first = entries[0];

            if (SKIP_EXISTING_DIGESTS && first.digest) {
                const projectName = `${first.workloadName}/${first.containerName}`;
                const exists = await checkExistingSbom(first.digest, projectName, first.namespace);
                if (exists) {
                    log.debug({ image: first.displayName, digest: first.digest }, "digest already indexed, skipping");
                    succeeded += entries.length;
                    return;
                }
            }

            await sem.acquire();
            let dockerConfigDir: string | undefined;
            let sbomFile: string | undefined;
            try {
                log.info({
                    image: first.displayName,
                    namespace: first.namespace,
                    workloadKind: first.workloadKind,
                    digest: first.digest ?? "(not available, pulling by tag)",
                }, "scanning image");

                if (RESOLVE_IMAGE_PULL_SECRETS && first.imagePullSecrets.length > 0) {
                    const resolved = await resolveRegistryAuth(
                        coreV1Api,
                        first.namespace,
                        first.imagePullSecrets,
                    );
                    if (Object.keys(resolved).length > 0) {
                        dockerConfigDir = buildTempDockerConfig(resolved);
                    }
                }

                try {
                    sbomFile = generateSBOM(first.pullRef, dockerConfigDir);
                } catch (err) {
                    log.error({
                        image: first.displayName,
                        err: err instanceof Error ? err.message : String(err),
                    }, "syft failed");
                    failed += entries.length;
                    return;
                }

                const { version, registry } = parseImageRef(first.displayName);

                for (const info of entries) {
                    const projectName = `${info.workloadName}/${info.containerName}`;
                    try {
                        await uploadSBOM(
                            sbomFile,
                            projectName,
                            version,
                            info.namespace,
                            registry,
                            info.digest,
                            info.pullRef,
                            info.workloadKind,
                            info.podLabels,
                            info.podAnnotations,
                        );
                        log.info({ projectName, version, namespace: info.namespace }, "upload succeeded");
                        succeeded++;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        const cause = err instanceof Error && (err as NodeJS.ErrnoException).cause;
                        const detail = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
                        log.error({ projectName, namespace: info.namespace, err: msg, cause: detail }, "upload failed");
                        failed++;
                    }
                }
            } finally {
                sem.release();
                if (dockerConfigDir) try { fs.rmSync(dockerConfigDir, { recursive: true }); } catch { /* ignore */ }
                if (sbomFile) try { fs.unlinkSync(sbomFile); } catch { /* ignore */ }
            }
        })
    );

    log.info({ succeeded, failed }, "scan complete");

    if (failed > 0 && succeeded === 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal error");
    process.exit(1);
});
