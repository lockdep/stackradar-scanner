import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";
import { OwnerMetadataCache } from "./owner-cache.js";
import { ownerKey } from "./scan.js";

/**
 * The fetching half of owner resolution: how many requests it makes, what it
 * does when they fail, and the one second hop that is worth taking.
 *
 * The *rule* — what the recovered labels then mean — is `inventory.test.ts`.
 */

interface Stub {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    /** `ownerReferences` on the fetched object, for the Job → CronJob hop. */
    ownerReferences?: k8s.V1OwnerReference[];
    /** Thrown instead of returned. */
    error?: unknown;
}

/**
 * A KubeConfig whose API clients are recording stubs.
 *
 * `makeApiClient` is the only member the cache touches, and every read method
 * lands in one counter — which is what makes "one `get` per controller per
 * process" an assertion rather than a claim.
 */
function fakeKubeConfig(objects: Record<string, Stub>) {
    const calls: string[] = [];

    const read = (kind: string) =>
        async ({ name, namespace }: { name: string; namespace: string }) => {
            const key = `${kind}/${namespace}/${name}`;
            calls.push(key);
            const stub = objects[key];
            if (!stub) throw new k8s.ApiException(404, "not found", {}, {});
            if (stub.error) throw stub.error;
            return {
                metadata: {
                    name,
                    namespace,
                    labels: stub.labels,
                    annotations: stub.annotations,
                    ownerReferences: stub.ownerReferences,
                },
            };
        };

    const api = {
        readNamespacedDeployment: read("Deployment"),
        readNamespacedStatefulSet: read("StatefulSet"),
        readNamespacedDaemonSet: read("DaemonSet"),
        readNamespacedReplicaSet: read("ReplicaSet"),
        readNamespacedJob: read("Job"),
        readNamespacedCronJob: read("CronJob"),
    };

    const kc = { makeApiClient: () => api } as unknown as k8s.KubeConfig;
    return { kc, calls };
}

function pod(options: {
    name: string;
    namespace?: string;
    kind: string;
    owner: string;
    uid?: string;
    labels?: Record<string, string>;
}): k8s.V1Pod {
    return {
        metadata: {
            name: options.name,
            namespace: options.namespace ?? "prod",
            labels: options.labels,
            ownerReferences: [{
                kind: options.kind,
                name: options.owner,
                uid: options.uid ?? "uid-1",
                apiVersion: "apps/v1",
                controller: true,
            }],
        },
    } as k8s.V1Pod;
}

describe("OwnerMetadataCache", () => {
    it("keeps only allowlisted controller metadata", async () => {
        const { kc } = fakeKubeConfig({
            "Deployment/prod/api": {
                labels: {
                    "helm.sh/chart": "api-1.2.3",
                    "customer.internal/cost-centre": "acme-holdings-emea",
                },
                annotations: {
                    "meta.helm.sh/release-name": "prod-api",
                    "kubectl.kubernetes.io/last-applied-configuration": "{}",
                },
            },
        });

        const { owners, collected } = await new OwnerMetadataCache(kc).resolve([
            pod({ name: "api-7d9f8b6c4d-abcde", kind: "ReplicaSet", owner: "api-7d9f8b6c4d",
                  labels: { "pod-template-hash": "7d9f8b6c4d" } }),
        ]);

        expect(collected).toBe(true);
        expect(owners.get(ownerKey("prod", "Deployment", "api"))).toEqual({
            labels: { "helm.sh/chart": "api-1.2.3" },
            annotations: { "meta.helm.sh/release-name": "prod-api" },
        });
    });

    /*
     * The whole justification for `get` over an informer. Ten replicas of one
     * Deployment are one request, and the second report makes none at all —
     * otherwise this would be a per-pod cost on a five-minute timer.
     */
    it("issues one request per controller, and none at all on a repeat report", async () => {
        const { kc, calls } = fakeKubeConfig({
            "Deployment/prod/api": { labels: { "helm.sh/chart": "api-1.2.3" } },
        });

        const replicas = Array.from({ length: 10 }, (_, i) =>
            pod({ name: `api-7d9f8b6c4d-${i}`, kind: "ReplicaSet", owner: "api-7d9f8b6c4d",
                  labels: { "pod-template-hash": "7d9f8b6c4d" } }));

        const cache = new OwnerMetadataCache(kc);
        await cache.resolve(replicas);
        expect(calls).toEqual(["Deployment/prod/api"]);

        const second = await cache.resolve(replicas);
        expect(calls).toHaveLength(1);
        expect(second.owners.get(ownerKey("prod", "Deployment", "api"))).toBeDefined();
        expect(cache.requestCount).toBe(1);
    });

    /*
     * A rollout replaces the ReplicaSet, which is exactly the moment the
     * rendered labels could have changed — a `helm upgrade` that bumps the
     * chart version looks like this. Memoising past it would serve the previous
     * chart version indefinitely.
     */
    it("re-reads a controller whose owner uid changed", async () => {
        const { kc, calls } = fakeKubeConfig({
            "Deployment/prod/api": { labels: { "helm.sh/chart": "api-1.2.3" } },
        });

        const cache = new OwnerMetadataCache(kc);
        await cache.resolve([pod({ name: "api-old-1", kind: "ReplicaSet", owner: "api-aaa",
                                   uid: "uid-old", labels: { "pod-template-hash": "aaa" } })]);
        await cache.resolve([pod({ name: "api-new-1", kind: "ReplicaSet", owner: "api-bbb",
                                   uid: "uid-new", labels: { "pod-template-hash": "bbb" } })]);

        expect(calls).toEqual(["Deployment/prod/api", "Deployment/prod/api"]);
    });

    /*
     * The one second hop. A Job created by a CronJob carries the chart labels
     * only if the CronJob's `jobTemplate` templated them through, and often it
     * did not — so the CronJob fills in what the Job never had, with the nearer
     * object still winning any key both carry.
     */
    it("takes the Job → CronJob hop, with the Job winning shared keys", async () => {
        const { kc, calls } = fakeKubeConfig({
            "Job/prod/nightly-29344": {
                labels: { "app.kubernetes.io/name": "nightly" },
                ownerReferences: [{
                    kind: "CronJob", name: "nightly", uid: "cj", apiVersion: "batch/v1", controller: true,
                }],
            },
            "CronJob/prod/nightly": {
                labels: { "helm.sh/chart": "jobs-2.0.0", "app.kubernetes.io/name": "from-cronjob" },
                annotations: { "meta.helm.sh/release-name": "prod-jobs" },
            },
        });

        const { owners } = await new OwnerMetadataCache(kc).resolve([
            pod({ name: "nightly-29344-abcde", kind: "Job", owner: "nightly-29344" }),
        ]);

        expect(calls).toEqual(["Job/prod/nightly-29344", "CronJob/prod/nightly"]);
        expect(owners.get(ownerKey("prod", "Job", "nightly-29344"))).toEqual({
            labels: { "helm.sh/chart": "jobs-2.0.0", "app.kubernetes.io/name": "nightly" },
            annotations: { "meta.helm.sh/release-name": "prod-jobs" },
        });
    });

    it("does not hop from a Job nothing created", async () => {
        const { kc, calls } = fakeKubeConfig({
            "Job/prod/one-off": { labels: { "helm.sh/chart": "jobs-2.0.0" } },
        });

        await new OwnerMetadataCache(kc).resolve([
            pod({ name: "one-off-abcde", kind: "Job", owner: "one-off" }),
        ]);

        expect(calls).toEqual(["Job/prod/one-off"]);
    });

    describe("when the RBAC is absent", () => {
        let warn: ReturnType<typeof vi.spyOn>;
        beforeEach(() => { warn = vi.spyOn(log, "warn").mockImplementation(() => {}); });
        afterEach(() => { warn.mockRestore(); });

        /*
         * Degrade, never fail. Pod-only attribution is what shipped before this
         * feature; a report that threw instead would cost the cluster its entire
         * inventory over a missing ClusterRole rule.
         */
        it("degrades to pod-only attribution and says so once", async () => {
            const denied = new k8s.ApiException(403, "forbidden", {}, {});
            const { kc, calls } = fakeKubeConfig({
                "Deployment/prod/api": { error: denied },
                "Deployment/prod/web": { error: denied },
            });

            const cache = new OwnerMetadataCache(kc);
            const { owners, collected } = await cache.resolve([
                pod({ name: "api-1", kind: "Deployment", owner: "api" }),
                pod({ name: "web-1", kind: "Deployment", owner: "web" }),
            ]);

            expect(owners.size).toBe(0);
            expect(collected).toBe(false);
            // One denial settles the question for the whole layer; the second
            // controller is never asked.
            expect(calls).toEqual(["Deployment/prod/api"]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]![1]).toContain("scanner.resolveWorkloadOwners");
        });

        /*
         * A 404 is ordinary — a Deployment deleted between the informer's
         * snapshot and this read — and must not be mistaken for a permissions
         * failure, which would make the whole report claim it could not look.
         */
        it("does not treat a missing controller as a permissions failure", async () => {
            const { kc } = fakeKubeConfig({});

            const { owners, collected } = await new OwnerMetadataCache(kc).resolve([
                pod({ name: "api-1", kind: "Deployment", owner: "api" }),
                pod({ name: "web-1", kind: "Deployment", owner: "web" }),
            ]);

            expect(owners.size).toBe(0);
            expect(collected).toBe(true);
            expect(warn).not.toHaveBeenCalled();
        });
    });

    /* A bare pod is its own controller and a `null` kind is an unresolvable
       chain. Neither has an object to read, and asking would be a guess. */
    it("asks for nothing when there is no controller to read", async () => {
        const { kc, calls } = fakeKubeConfig({});
        const bare = { metadata: { name: "debug", namespace: "prod" } } as k8s.V1Pod;

        const { owners } = await new OwnerMetadataCache(kc).resolve([bare]);

        expect(calls).toEqual([]);
        expect(owners.size).toBe(0);
    });

    /* An excluded namespace is not scanned, so its controllers are not read
       either — the RBAC grant must not turn into traffic about `kube-system`. */
    it("skips pods in namespaces the scanner does not scan", async () => {
        const { kc, calls } = fakeKubeConfig({
            "Deployment/kube-system/coredns": { labels: { "helm.sh/chart": "coredns-1.0.0" } },
        });

        await new OwnerMetadataCache(kc).resolve([
            pod({ name: "coredns-1", namespace: "kube-system", kind: "Deployment", owner: "coredns" }),
        ]);

        expect(calls).toEqual([]);
    });

    /* A CR that owns pods directly — a Rollout, a Cluster. The agent has no
       RBAC for it and no idea which API group it lives in, so it does not ask. */
    it("skips a controller kind it has no reader for", async () => {
        const { kc, calls } = fakeKubeConfig({});

        await new OwnerMetadataCache(kc).resolve([
            pod({ name: "pg-1", kind: "Cluster", owner: "pg" }),
        ]);

        expect(calls).toEqual([]);
    });
});
