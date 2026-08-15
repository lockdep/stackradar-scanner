import { describe, it, expect } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { buildInventory, parseHelmChartLabel, podImages, resolveOwner } from "./scan.js";

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

interface PodOptions {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    phase?: string;
    startTime?: Date;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
    containers?: { name: string; image: string; imageID?: string; running?: boolean }[];
    initContainers?: { name: string; image: string; imageID?: string }[];
}

function pod(options: PodOptions): k8s.V1Pod {
    const containers = options.containers ?? [
        { name: "main", image: "ghcr.io/acme/api:v1", imageID: `ghcr.io/acme/api@${DIGEST_A}` },
    ];
    return {
        metadata: {
            name: options.name,
            namespace: options.namespace ?? "default",
            labels: options.labels,
            annotations: options.annotations,
            ownerReferences: options.ownerReferences as k8s.V1OwnerReference[] | undefined,
        },
        spec: {},
        status: {
            phase: options.phase ?? "Running",
            startTime: options.startTime,
            containerStatuses: containers.map((c) => ({
                name: c.name,
                image: c.image,
                imageID: c.imageID ?? "",
                ready: true,
                restartCount: 0,
                state: c.running === false ? { waiting: {} } : { running: { startedAt: new Date() } },
            })),
            initContainerStatuses: (options.initContainers ?? []).map((c) => ({
                name: c.name,
                image: c.image,
                imageID: c.imageID ?? "",
                ready: true,
                restartCount: 0,
                state: { terminated: { exitCode: 0 } },
            })),
        },
    } as k8s.V1Pod;
}

/** A pod owned by a Deployment, spelled the way Kubernetes actually spells it. */
function deploymentPod(name: string, deployment: string, hash: string, rest: Partial<PodOptions> = {}): k8s.V1Pod {
    return pod({
        name,
        ownerReferences: [{ kind: "ReplicaSet", name: `${deployment}-${hash}`, controller: true }],
        ...rest,
        labels: { "pod-template-hash": hash, ...rest.labels },
    });
}

/**
 * `workloadKind` used to be the literal string `"Pod"` for every workload in
 * every cluster. It becomes a `kubectl set image deployment/x` in the
 * remediation flow, so a wrong one is actively misleading — worse than an
 * absent one.
 */
describe("resolveOwner", () => {
    it("resolves a ReplicaSet-owned pod to its Deployment", () => {
        const owner = resolveOwner(deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d"));
        expect(owner).toEqual({ kind: "Deployment", name: "api" });
    });

    /* Without the hash we cannot prove the ReplicaSet came from a Deployment,
       so we report the ReplicaSet rather than inventing a Deployment name. */
    it("reports a ReplicaSet when the pod-template-hash label is missing", () => {
        const owner = resolveOwner(pod({
            name: "api-abcde",
            ownerReferences: [{ kind: "ReplicaSet", name: "api-7d9f8b6c4d", controller: true }],
        }));
        expect(owner).toEqual({ kind: "ReplicaSet", name: "api-7d9f8b6c4d" });
    });

    it("passes StatefulSet and DaemonSet through unchanged", () => {
        expect(resolveOwner(pod({
            name: "pg-0",
            ownerReferences: [{ kind: "StatefulSet", name: "pg", controller: true }],
        }))).toEqual({ kind: "StatefulSet", name: "pg" });

        expect(resolveOwner(pod({
            name: "node-exporter-xk2p9",
            ownerReferences: [{ kind: "DaemonSet", name: "node-exporter", controller: true }],
        }))).toEqual({ kind: "DaemonSet", name: "node-exporter" });
    });

    /* `Job` is true; `CronJob` might not be, and resolving the second hop would
       need the Job object and the RBAC to read it. */
    it("reports Job rather than guessing at a CronJob", () => {
        expect(resolveOwner(pod({
            name: "backup-28001440-abcde",
            ownerReferences: [{ kind: "Job", name: "backup-28001440", controller: true }],
        }))).toEqual({ kind: "Job", name: "backup-28001440" });
    });

    it("reports Pod only for a pod that genuinely has no owner", () => {
        const owner = resolveOwner(pod({ name: "debug-shell", labels: { app: "debug" } }));
        expect(owner.kind).toBe("Pod");
    });
});

describe("parseHelmChartLabel", () => {
    it("splits at the last hyphen that begins a version", () => {
        expect(parseHelmChartLabel("nginx-18.2.1")).toEqual({ chartName: "nginx", chartVersion: "18.2.1" });
        // Chart names contain hyphens; splitting at the first one would give
        // `kube` / `prometheus-stack-51.2.0`.
        expect(parseHelmChartLabel("kube-prometheus-stack-51.2.0")).toEqual({
            chartName: "kube-prometheus-stack",
            chartVersion: "51.2.0",
        });
        expect(parseHelmChartLabel("app-v2.0.0")).toEqual({ chartName: "app", chartVersion: "v2.0.0" });
    });

    it("returns the whole label as a name when no version is present", () => {
        expect(parseHelmChartLabel("locally-built")).toEqual({ chartName: "locally-built", chartVersion: null });
    });

    it("returns nulls for a missing label", () => {
        expect(parseHelmChartLabel(undefined)).toEqual({ chartName: null, chartVersion: null });
    });
});

/**
 * The inventory report is the primary write path for the control plane's
 * `namespaces`, `workloads`, `workload_containers` and `helm_releases` — not
 * just a progress hint. What matters here is that it reports the same
 * containers the scan queue would upload, and that the two aggregation rules
 * (replicas collapse, digests do not) hold.
 */
describe("buildInventory", () => {
    it("declares version 2 and a synced informer", () => {
        const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
        expect(report.version).toBe(2);
        expect(report.informerSynced).toBe(true);
        expect(report.reportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("collapses replicas of one workload into a single entry with a pod count", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d"),
            deploymentPod("api-7d9f8b6c4d-fghij", "api", "7d9f8b6c4d"),
            deploymentPod("api-7d9f8b6c4d-klmno", "api", "7d9f8b6c4d"),
        ]);

        expect(report.namespaces).toHaveLength(1);
        const workloads = report.namespaces[0]!.workloads;
        expect(workloads).toHaveLength(1);
        expect(workloads[0]).toMatchObject({ kind: "Deployment", name: "api", runningPods: 3 });
        expect(workloads[0]!.containers[0]).toMatchObject({ name: "main", runningPods: 3 });
    });

    /**
     * The container identity that includes the digest. A Deployment mid-rollout
     * runs two digests under one container name, and collapsing them would
     * report a fix as deployed while the old image is still serving.
     */
    it("keeps two digests of one container name as two entries", () => {
        const report = buildInventory([
            deploymentPod("api-old-abcde", "api", "old"),
            deploymentPod("api-new-fghij", "api", "new", {
                containers: [{ name: "main", image: "ghcr.io/acme/api:v2", imageID: `ghcr.io/acme/api@${DIGEST_B}` }],
            }),
        ]);

        // Two ReplicaSets of one Deployment collapse to one workload...
        const workloads = report.namespaces[0]!.workloads;
        expect(workloads).toHaveLength(1);
        // ...carrying two container rows, one per digest.
        expect(workloads[0]!.containers).toHaveLength(2);
        expect(workloads[0]!.containers.map((c) => c.imageDigest).sort()).toEqual([DIGEST_A, DIGEST_B].sort());
        expect(workloads[0]!.containers.every((c) => c.name === "main")).toBe(true);
        expect(workloads[0]!.containers.map((c) => c.runningPods)).toEqual([1, 1]);
    });

    it("counts each container of a multi-container pod separately", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                containers: [
                    { name: "main", image: "ghcr.io/acme/api:v1", imageID: `ghcr.io/acme/api@${DIGEST_A}` },
                    { name: "sidecar", image: "ghcr.io/acme/proxy:v1", imageID: `ghcr.io/acme/proxy@${DIGEST_B}` },
                ],
            }),
        ]);

        const containers = report.namespaces[0]!.workloads[0]!.containers;
        expect(containers.map((c) => c.name).sort()).toEqual(["main", "sidecar"]);
    });

    it("flags init containers rather than merging them with the rest", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                initContainers: [{ name: "migrate", image: "ghcr.io/acme/migrate:v1", imageID: `ghcr.io/acme/migrate@${DIGEST_B}` }],
            }),
        ]);

        const containers = report.namespaces[0]!.workloads[0]!.containers;
        const byName = new Map(containers.map((c) => [c.name, c]));
        expect(byName.get("main")!.init).toBe(false);
        expect(byName.get("migrate")!.init).toBe(true);
    });

    it("separates the same workload name in different namespaces", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", { namespace: "prod" }),
            deploymentPod("api-7d9f8b6c4d-fghij", "api", "7d9f8b6c4d", { namespace: "staging" }),
        ]);

        expect(report.namespaces.map((n) => n.name).sort()).toEqual(["prod", "staging"]);
    });

    /** Null, not `{}` — the agent has no `namespaces: list` RBAC yet, and
     *  reporting `{}` would make a missing permission look like an unlabelled
     *  namespace. */
    it("reports namespace labels as not-collected", () => {
        const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
        expect(report.namespaces[0]!.labels).toBeNull();
    });

    it("reports the digest-pinned reference the scanner would pull", () => {
        const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
        const container = report.namespaces[0]!.workloads[0]!.containers[0]!;

        expect(container.imageRef).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
        expect(container.imageDigest).toBe(DIGEST_A);
        expect(container.imageTag).toBe("v1");
        expect(container.registry).toBe("ghcr.io");
        expect(container.repository).toBe("acme/api");
    });

    it("reports no tag for a digest-pinned deployment", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                containers: [{
                    name: "main",
                    image: `ghcr.io/acme/api@${DIGEST_A}`,
                    imageID: `ghcr.io/acme/api@${DIGEST_A}`,
                }],
            }),
        ]);

        expect(report.namespaces[0]!.workloads[0]!.containers[0]!.imageTag).toBeNull();
    });

    describe("helm releases", () => {
        const helmPod = (namespace: string, releaseNamespace: string) =>
            deploymentPod("redis-master-7d9f8b6c4d-abcde", "redis-master", "7d9f8b6c4d", {
                namespace,
                labels: { "helm.sh/chart": "redis-18.2.1", "app.kubernetes.io/version": "7.2.4" },
                annotations: {
                    "meta.helm.sh/release-name": "prod-redis",
                    "meta.helm.sh/release-namespace": releaseNamespace,
                },
            });

        it("derives a release from annotations when Helm wrote them", () => {
            const report = buildInventory([helmPod("prod", "prod")]);

            expect(report.releases).toEqual([{
                name: "prod-redis",
                namespace: "prod",
                chartName: "redis",
                chartVersion: "18.2.1",
                appVersion: "7.2.4",
                // Pod metadata cannot supply it, and null means unknown, not
                // "no repo".
                repoUrl: null,
                source: "helm",
            }]);
            expect(report.namespaces[0]!.workloads[0]!.release).toEqual({ name: "prod-redis", namespace: "prod" });
        });

        /* A chart may deploy into namespaces other than the release's own.
           Keying on the workload's namespace would split one release in two. */
        it("keys the release on its own namespace, not the workload's", () => {
            const report = buildInventory([helmPod("redis-data", "prod")]);

            expect(report.releases[0]!.namespace).toBe("prod");
            expect(report.namespaces[0]!.name).toBe("redis-data");
            expect(report.namespaces[0]!.workloads[0]!.release).toEqual({ name: "prod-redis", namespace: "prod" });
        });

        /*
         * The case every real cluster is in. `meta.helm.sh/release-*` lives on
         * the Deployment, never on the pod template, so a check that required
         * it found zero releases on a cluster where `helm list` shows a dozen.
         * The standard labels are what actually reach the pod.
         */
        it("derives a release from the standard labels, with no annotations at all", () => {
            const report = buildInventory([
                deploymentPod("cert-manager-77dc4bb696-zsr7w", "cert-manager", "77dc4bb696", {
                    namespace: "cert-manager",
                    labels: {
                        "app.kubernetes.io/instance": "cert-manager",
                        "app.kubernetes.io/managed-by": "Helm",
                        "app.kubernetes.io/version": "v1.19.2",
                        "helm.sh/chart": "cert-manager-v1.19.2",
                    },
                }),
            ]);

            expect(report.releases).toEqual([{
                name: "cert-manager",
                namespace: "cert-manager",
                chartName: "cert-manager",
                chartVersion: "v1.19.2",
                appVersion: "v1.19.2",
                repoUrl: null,
                source: "helm",
            }]);
            expect(report.namespaces[0]!.workloads[0]!.release)
                .toEqual({ name: "cert-manager", namespace: "cert-manager" });
        });

        /* Charts that never migrated off Helm 2's label spelling. */
        it("falls back to the pre-3.0 release/chart/heritage labels", () => {
            const report = buildInventory([
                deploymentPod("kps-operator-6846466799-lbjc9", "kps-operator", "6846466799", {
                    namespace: "monitoring",
                    labels: {
                        release: "kube-prometheus-stack",
                        chart: "kube-prometheus-stack-82.18.0",
                        heritage: "Helm",
                    },
                }),
            ]);

            expect(report.releases).toEqual([{
                name: "kube-prometheus-stack",
                namespace: "monitoring",
                chartName: "kube-prometheus-stack",
                chartVersion: "82.18.0",
                appVersion: null,
                repoUrl: null,
                source: "helm",
            }]);
        });

        /*
         * prometheus-operator stamps `app.kubernetes.io/instance` on pods of
         * StatefulSets it generates itself. Trusting `instance` unconditionally
         * would invent `kube-prometheus-stack-alertmanager` as a release that
         * no `helm list` will ever show.
         */
        it("ignores an instance label owned by a controller that is not Helm", () => {
            const report = buildInventory([
                pod({
                    name: "alertmanager-kube-prometheus-stack-alertmanager-0",
                    namespace: "monitoring",
                    ownerReferences: [{ kind: "StatefulSet", name: "alertmanager-kps-alertmanager", controller: true }],
                    labels: {
                        "app.kubernetes.io/instance": "kube-prometheus-stack-alertmanager",
                        "app.kubernetes.io/managed-by": "prometheus-operator",
                    },
                }),
            ]);

            expect(report.releases).toEqual([]);
            expect(report.namespaces[0]!.workloads[0]!.release).toBeNull();
        });

        /*
         * Subcharts. Every pod of one release carries its *own* chart label, so
         * "last pod wins" would name the release after whichever subchart the
         * informer handed over last — an answer that changes between reports
         * with nothing changing in the cluster.
         */
        it("names a release after its umbrella chart, not whichever subchart came last", () => {
            const member = (name: string, chartLabels: Record<string, string>) =>
                deploymentPod(`${name}-699f74b8c6-hl4x2`, name, "699f74b8c6", {
                    namespace: "monitoring",
                    labels: { "app.kubernetes.io/instance": "kube-prometheus-stack", ...chartLabels },
                });

            const pods = [
                member("kube-prometheus-stack-grafana", { "helm.sh/chart": "grafana-11.3.7" }),
                member("kube-prometheus-stack-operator", { chart: "kube-prometheus-stack-82.18.0" }),
                member("kube-prometheus-stack-kube-state-metrics", { "helm.sh/chart": "kube-state-metrics-7.2.2" }),
            ];

            for (const order of [pods, [...pods].reverse()]) {
                const report = buildInventory(order);
                expect(report.releases).toHaveLength(1);
                expect(report.releases[0]).toMatchObject({
                    name: "kube-prometheus-stack",
                    chartName: "kube-prometheus-stack",
                    chartVersion: "82.18.0",
                });
            }
        });

        it("reports no release for a workload no chart manages", () => {
            const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
            expect(report.releases).toEqual([]);
            expect(report.namespaces[0]!.workloads[0]!.release).toBeNull();
        });
    });

    it("excludes namespaces the scanner is configured to skip", () => {
        // `kube-system` is in the default EXCLUDE_NAMESPACES set.
        const report = buildInventory([pod({ name: "coredns-abc", namespace: "kube-system", labels: { app: "coredns" } })]);
        expect(report.namespaces).toEqual([]);
    });

    it("omits containers that have not started, since there is nothing to scan yet", () => {
        const report = buildInventory([
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                containers: [{ name: "main", image: "ghcr.io/acme/api:v1", imageID: "", running: false }],
            }),
        ]);

        expect(report.namespaces).toEqual([]);
    });

    it("counts exactly what the scan queue would enqueue", () => {
        const pods = [
            deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d"),
            deploymentPod("api-7d9f8b6c4d-fghij", "api", "7d9f8b6c4d"),
            deploymentPod("web-5c6d7e8f9a-klmno", "web", "5c6d7e8f9a", {
                containers: [{ name: "main", image: "ghcr.io/acme/web:v1", imageID: `ghcr.io/acme/web@${DIGEST_B}` }],
            }),
        ];

        // Every container the inventory reports is one the scanner would also
        // try to scan; a discovered count larger than that would never converge.
        const scannable = new Set(
            pods.flatMap(podImages).map((i) => `${i.namespace}/${i.workloadName}/${i.containerName}/${i.digest}`),
        );
        const discovered = buildInventory(pods).namespaces.flatMap((ns) =>
            ns.workloads.flatMap((w) => w.containers.map((c) => `${ns.name}/${w.name}/${c.name}/${c.imageDigest}`)),
        );

        expect(new Set(discovered)).toEqual(scannable);
    });
});
