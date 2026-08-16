import { describe, it, expect } from "vitest";
import * as k8s from "@kubernetes/client-node";
import {
    buildInventory,
    ownerKey,
    parseHelmChartLabel,
    podImages,
    resolveOwner,
    type OwnerMetadataLookup,
} from "./scan.js";

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

/**
 * A one-entry controller-metadata lookup, keyed the way `podImages` looks it up.
 *
 * Built by hand rather than by mocking the API: the interesting behaviour is
 * what the *rule* does with the labels, and `owner-cache.test.ts` covers the
 * fetching separately.
 */
function owners(entry: {
    namespace: string;
    kind: string;
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
}): OwnerMetadataLookup {
    return new Map([[
        ownerKey(entry.namespace, entry.kind, entry.name),
        { labels: entry.labels ?? {}, annotations: entry.annotations ?? {} },
    ]]);
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
    it("declares version 3 and a synced informer", () => {
        const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
        expect(report.version).toBe(3);
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
            }]);
        });

        /*
         * prometheus-operator stamps `app.kubernetes.io/instance` on pods of
         * StatefulSets it generates itself. Trusting `instance` unconditionally
         * would invent `kube-prometheus-stack-alertmanager` as a release that
         * no `helm list` will ever show — so an instance label on its own,
         * with nothing anywhere saying Helm, is not evidence of a release.
         */
        it("reports no release for an instance label with no Helm evidence behind it", () => {
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

    /*
     * The reported bug, and the class of failure behind it: the pod is the one
     * object in the chain that usually does *not* carry chart context, so
     * everything here is about evidence found one hop up.
     */
    describe("releases derived from the controller", () => {
        /*
         * `alertmanager-kube-prometheus-stack-alertmanager`, with the label sets
         * measured on the dev cluster. The StatefulSet carries Helm's full
         * pre-3.0 set; its `spec.template.metadata.labels` carries none of it,
         * because prometheus-operator writes its own for the pods it manages.
         */
        const alertmanagerPod = pod({
            name: "alertmanager-kube-prometheus-stack-alertmanager-0",
            namespace: "monitoring",
            ownerReferences: [{
                kind: "StatefulSet",
                name: "alertmanager-kube-prometheus-stack-alertmanager",
                controller: true,
            }],
            labels: {
                "app.kubernetes.io/instance": "kube-prometheus-stack-alertmanager",
                "app.kubernetes.io/managed-by": "prometheus-operator",
                "app.kubernetes.io/name": "alertmanager",
            },
        });

        const alertmanagerStatefulSet = owners({
            namespace: "monitoring",
            kind: "StatefulSet",
            name: "alertmanager-kube-prometheus-stack-alertmanager",
            labels: {
                chart: "kube-prometheus-stack-82.18.0",
                heritage: "Helm",
                release: "kube-prometheus-stack",
                "app.kubernetes.io/part-of": "kube-prometheus-stack",
                "app.kubernetes.io/managed-by": "prometheus-operator",
            },
        });

        it("recovers the release the controller names, despite managed-by on the pod", () => {
            const report = buildInventory([alertmanagerPod], { owners: alertmanagerStatefulSet });

            expect(report.releases).toEqual([{
                name: "kube-prometheus-stack",
                namespace: "monitoring",
                chartName: "kube-prometheus-stack",
                chartVersion: "82.18.0",
                appVersion: null,
                repoUrl: null,
            }]);
            expect(report.namespaces[0]!.workloads[0]!.release)
                .toEqual({ name: "kube-prometheus-stack", namespace: "monitoring" });
        });

        /*
         * `app.kubernetes.io/instance` on this pod is
         * `kube-prometheus-stack-alertmanager` — the operator being *correct*,
         * since every instance of an application must have a unique name. Read
         * as a release name it would split one release into three, which is
         * precisely why `release` outranks it under corroboration.
         */
        it("does not name the release after the operator's instance key", () => {
            const report = buildInventory([alertmanagerPod], { owners: alertmanagerStatefulSet });
            expect(report.releases.map((r) => r.name)).toEqual(["kube-prometheus-stack"]);
        });

        /*
         * The other half of the same bug: the pod knows the release but not the
         * chart, so the release row existed and was unusable for the one thing
         * releases are for — "what chart is this, and is there a newer one".
         */
        it("fills in a chart the pod does not carry", () => {
            const report = buildInventory(
                [pod({
                    name: "loki-0",
                    namespace: "monitoring",
                    ownerReferences: [{ kind: "StatefulSet", name: "loki", controller: true }],
                    labels: { "app.kubernetes.io/instance": "loki" },
                })],
                {
                    owners: owners({
                        namespace: "monitoring",
                        kind: "StatefulSet",
                        name: "loki",
                        labels: { "helm.sh/chart": "loki-6.55.0" },
                    }),
                },
            );

            expect(report.releases[0]).toMatchObject({
                name: "loki",
                chartName: "loki",
                chartVersion: "6.55.0",
            });
        });

        /* Owner metadata is additive only. A pod that already knew its release
           keeps that answer whatever the controller says. */
        it("never lets the controller override a label the pod carries", () => {
            const report = buildInventory(
                [deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                    namespace: "prod",
                    labels: {
                        "app.kubernetes.io/instance": "from-pod",
                        "helm.sh/chart": "api-1.0.0",
                    },
                })],
                {
                    owners: owners({
                        namespace: "prod",
                        kind: "Deployment",
                        name: "api",
                        labels: {
                            "app.kubernetes.io/instance": "from-controller",
                            "helm.sh/chart": "api-9.9.9",
                        },
                    }),
                },
            );

            expect(report.releases[0]).toMatchObject({ name: "from-pod", chartVersion: "1.0.0" });
        });

        /*
         * The guard must not be weakened into "any instance label is a
         * release". With nothing anywhere saying Helm, there is no release.
         */
        it("still reports nothing when the controller carries no Helm evidence either", () => {
            const report = buildInventory(
                [pod({
                    name: "hubble-relay-abc",
                    namespace: "monitoring",
                    ownerReferences: [{ kind: "Deployment", name: "hubble-relay", controller: true }],
                    labels: { "app.kubernetes.io/instance": "hubble-relay" },
                })],
                {
                    owners: owners({
                        namespace: "monitoring",
                        kind: "Deployment",
                        name: "hubble-relay",
                        labels: { "app.kubernetes.io/part-of": "cilium" },
                    }),
                },
            );

            expect(report.releases).toEqual([]);
            expect(report.namespaces[0]!.workloads[0]!.release).toBeNull();
        });

        /*
         * `managed-by` is the tool that *operates* an application, per the label
         * spec — never the installer. It is one way to say Helm and never a way
         * to say not-Helm.
         */
        it("accepts managed-by: Helm as evidence on its own", () => {
            const report = buildInventory([
                deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                    namespace: "prod",
                    labels: {
                        "app.kubernetes.io/instance": "api",
                        "app.kubernetes.io/managed-by": "Helm",
                    },
                }),
            ]);

            expect(report.releases[0]).toMatchObject({ name: "api", chartName: null });
        });

        /*
         * Unprefixed keys are private to users per the spec, so `release` names
         * a release only when the object corroborates the Helm spelling.
         * Uncorroborated, `release: stable` is somebody's channel marker and
         * the prefixed label is the safer of the two.
         */
        it("prefers release over instance when the object corroborates Helm", () => {
            const report = buildInventory([
                deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                    namespace: "prod",
                    labels: {
                        release: "prod-api",
                        "app.kubernetes.io/instance": "api-abcxyz",
                        heritage: "Helm",
                    },
                }),
            ]);

            expect(report.releases[0]!.name).toBe("prod-api");
        });

        it("prefers instance over an uncorroborated release label", () => {
            const report = buildInventory([
                deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d", {
                    namespace: "prod",
                    labels: {
                        release: "stable",
                        "app.kubernetes.io/instance": "prod-api",
                        "app.kubernetes.io/managed-by": "Helm",
                    },
                }),
            ]);

            expect(report.releases[0]!.name).toBe("prod-api");
        });

        /* `appVersion` comes from a label charts get wrong — five of fifteen
           releases on the dev cluster stamp the chart version into it. Equal is
           allowed; derived is not. */
        it("keeps appVersion and chartVersion distinct even when equal", () => {
            const report = buildInventory([
                deploymentPod("kps-operator-6846466799-lbjc9", "kps-operator", "6846466799", {
                    namespace: "monitoring",
                    labels: {
                        "app.kubernetes.io/instance": "kube-prometheus-stack",
                        "helm.sh/chart": "kube-prometheus-stack-82.18.0",
                        "app.kubernetes.io/version": "82.18.0",
                    },
                }),
            ]);

            expect(report.releases[0]).toMatchObject({
                chartVersion: "82.18.0",
                appVersion: "82.18.0",
            });
        });

        /* The merged set reaches the client, which is what lets the Unmanaged
           bucket sub-group by `part-of` with no new column and no new table. */
        it("reports the merged label set on the workload", () => {
            const report = buildInventory([alertmanagerPod], { owners: alertmanagerStatefulSet });

            expect(report.namespaces[0]!.workloads[0]!.labels).toEqual({
                // the controller's
                chart: "kube-prometheus-stack-82.18.0",
                heritage: "Helm",
                release: "kube-prometheus-stack",
                "app.kubernetes.io/part-of": "kube-prometheus-stack",
                // the pod's, winning the key both carry
                "app.kubernetes.io/instance": "kube-prometheus-stack-alertmanager",
                "app.kubernetes.io/managed-by": "prometheus-operator",
                "app.kubernetes.io/name": "alertmanager",
            });
        });

        it("reports whether the controllers could be read at all", () => {
            const pods = [alertmanagerPod];
            expect(buildInventory(pods, { ownerMetadataCollected: false }).ownerMetadataCollected)
                .toBe(false);
            expect(buildInventory(pods, { owners: alertmanagerStatefulSet }).ownerMetadataCollected)
                .toBe(true);
        });
    });

    /*
     * The delivery layer. It is a sibling of the release, never a value on it:
     * ArgoCD commonly deploys *via* Helm, so a workload legitimately has both
     * and a single field would force a choice between two true answers.
     */
    describe("gitops applications", () => {
        const trackedPod = (name: string, workload: string) =>
            pod({
                name,
                namespace: "monitoring",
                ownerReferences: [{ kind: "Deployment", name: workload, controller: true }],
                labels: {
                    "app.kubernetes.io/instance": "kube-prometheus-stack",
                    "helm.sh/chart": "kube-prometheus-stack-82.18.0",
                },
            });

        const trackingOwners = (workload: string, trackingId: string) =>
            owners({
                namespace: "monitoring",
                kind: "Deployment",
                name: workload,
                annotations: { "argocd.argoproj.io/tracking-id": trackingId },
            });

        it("reads the tracking annotation off the controller, where it lives", () => {
            const report = buildInventory(
                [trackedPod("kps-operator-1", "kps-operator")],
                {
                    owners: trackingOwners(
                        "kps-operator",
                        "kube-prometheus-stack:apps/Deployment:monitoring/kps-operator"
                    ),
                },
            );

            expect(report.applications).toEqual([{
                name: "kube-prometheus-stack",
                namespace: "argocd",
                tool: "argocd",
                repoUrl: null,
                targetRevision: null,
                chart: null,
                path: null,
                destinationNamespace: null,
            }]);
            expect(report.namespaces[0]!.workloads[0]!.application)
                .toEqual({ name: "kube-prometheus-stack", namespace: "argocd" });
        });

        /*
         * `kube-prometheus-stack` is legitimately both a Helm release and an
         * ArgoCD app. The two layers must not leak into each other: an app name
         * never lands in `releases[]`, and the workload carries both references.
         */
        it("carries both layers for a workload that has both", () => {
            const report = buildInventory(
                [trackedPod("kps-operator-1", "kps-operator")],
                {
                    owners: trackingOwners(
                        "kps-operator",
                        "kube-prometheus-stack:apps/Deployment:monitoring/kps-operator"
                    ),
                },
            );

            expect(report.releases).toHaveLength(1);
            expect(report.applications).toHaveLength(1);
            expect(report.releases[0]).not.toHaveProperty("tool");
            expect(report.namespaces[0]!.workloads[0]).toMatchObject({
                release: { name: "kube-prometheus-stack", namespace: "monitoring" },
                application: { name: "kube-prometheus-stack", namespace: "argocd" },
            });
        });

        it("reports no application for a workload no GitOps tool delivers", () => {
            const report = buildInventory([deploymentPod("api-7d9f8b6c4d-abcde", "api", "7d9f8b6c4d")]);
            expect(report.applications).toEqual([]);
            expect(report.namespaces[0]!.workloads[0]!.application).toBeNull();
        });

        it("honours the configured ArgoCD namespace", () => {
            const report = buildInventory(
                [trackedPod("kps-operator-1", "kps-operator")],
                {
                    owners: trackingOwners("kps-operator", "app:apps/Deployment:monitoring/kps-operator"),
                    argocdNamespace: "gitops",
                },
            );
            expect(report.applications[0]!.namespace).toBe("gitops");
        });

        /* Phase C: the Application object supplies what the annotation cannot,
           and that is where a `targetRevision` bump — the actual fix — is made. */
        it("enriches the application row from a resolved Application object", () => {
            const resolved = new Map([[
                "argocd\u0000kube-prometheus-stack",
                {
                    name: "kube-prometheus-stack",
                    namespace: "argocd",
                    tool: "argocd" as const,
                    repoUrl: "https://prometheus-community.github.io/helm-charts",
                    targetRevision: "82.18.0",
                    chart: "kube-prometheus-stack",
                    path: null,
                    destinationNamespace: "monitoring",
                },
            ]]);

            const report = buildInventory(
                [trackedPod("kps-operator-1", "kps-operator")],
                {
                    owners: trackingOwners(
                        "kps-operator",
                        "kube-prometheus-stack:apps/Deployment:monitoring/kps-operator"
                    ),
                    applications: resolved,
                },
            );

            expect(report.applications[0]).toMatchObject({
                repoUrl: "https://prometheus-community.github.io/helm-charts",
                targetRevision: "82.18.0",
                chart: "kube-prometheus-stack",
            });
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
            pods.flatMap((p) => podImages(p)).map((i) => `${i.namespace}/${i.workloadName}/${i.containerName}/${i.digest}`),
        );
        const discovered = buildInventory(pods).namespaces.flatMap((ns) =>
            ns.workloads.flatMap((w) => w.containers.map((c) => `${ns.name}/${w.name}/${c.name}/${c.imageDigest}`)),
        );

        expect(new Set(discovered)).toEqual(scannable);
    });
});
