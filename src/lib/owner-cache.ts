import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";
import {
    OwnerMetadata,
    ownerKey,
    pickOwnerLabels,
    pickOwnerAnnotations,
    resolveOwner,
    shouldScan,
} from "./scan.js";

/**
 * Reading the metadata of the object a pod's containers actually belong to.
 *
 * **Why this exists at all.** The chart context the inventory needs is written
 * on the controller, not on the pod: Helm puts `meta.helm.sh/release-*` on the
 * objects it applies and never on the pod template inside them, ArgoCD
 * annotates what it applies and nothing propagates that downward, and an
 * operator that generates a StatefulSet from a CR writes its own label set for
 * the pods it manages — dropping `chart`, `heritage` and `release` on the way
 * through. The recommended-labels spec assumes as much: "they should be applied
 * on every resource object", and the pod is simply the object furthest from the
 * packaging decision. This is the one-sentence answer to "why does the agent
 * need to read Deployments".
 *
 * **Why `get` and not an informer.** An informer per kind is four more watches
 * and their memory, for metadata that changes on deploy rather than on pod
 * churn. One `get` per distinct `(kind, namespace, name)`, memoised for the life
 * of the process, is ~40 requests on a small cluster and ~1 per new workload
 * afterwards — and it runs on the inventory publish path, never on the informer
 * hot path where a pod update would multiply it by the replica count.
 *
 * **Why `PartialObjectMetadata`.** The `Accept` header asks the API server for
 * labels and annotations and nothing else, so the pod spec never crosses the
 * wire. The RBAC is identical either way; what it buys is that "the agent reads
 * metadata, not workload specs" stays literally true, which is a sentence
 * README.md can afford to make to a security reviewer.
 */

/**
 * Content negotiation for a metadata-only read.
 *
 * The API server returns a `PartialObjectMetadata` — `apiVersion`, `kind` and
 * `metadata`, with `spec` and `status` omitted entirely. A server too old to
 * know the type ignores the parameters and returns the full object, which
 * deserialises into the same shape for the two fields read here, so this
 * degrades rather than fails.
 */
const PARTIAL_METADATA_ACCEPT =
    "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=1,application/json";

/** Controller kinds whose metadata is worth a request, and where to find them. */
type Reader = (
    name: string,
    namespace: string,
    options: k8s.ConfigurationOptions,
) => Promise<{ metadata?: k8s.V1ObjectMeta }>;

/**
 * The `ownerReferences` kinds `resolveOwner` can produce, minus `Pod`.
 *
 * A bare pod is its own controller and has already been read; everything else
 * here maps one-to-one onto a `get` the ClusterRole grants. An unrecognised
 * kind — a CR that owns pods directly — resolves to no reader and is skipped
 * silently rather than guessed at: the agent has no RBAC for it and no idea
 * which API group it lives in.
 */
function readers(kc: k8s.KubeConfig): Map<string, Reader> {
    const apps = kc.makeApiClient(k8s.AppsV1Api);
    const batch = kc.makeApiClient(k8s.BatchV1Api);

    return new Map<string, Reader>([
        ["Deployment", (name, namespace, o) => apps.readNamespacedDeployment({ name, namespace }, o)],
        ["StatefulSet", (name, namespace, o) => apps.readNamespacedStatefulSet({ name, namespace }, o)],
        ["DaemonSet", (name, namespace, o) => apps.readNamespacedDaemonSet({ name, namespace }, o)],
        ["ReplicaSet", (name, namespace, o) => apps.readNamespacedReplicaSet({ name, namespace }, o)],
        ["Job", (name, namespace, o) => batch.readNamespacedJob({ name, namespace }, o)],
        ["CronJob", (name, namespace, o) => batch.readNamespacedCronJob({ name, namespace }, o)],
    ]);
}

/** What a pod says about its controller before anything has been fetched. */
interface OwnerRef {
    kind: string;
    namespace: string;
    name: string;
    /**
     * The **direct** controller reference's uid — the ReplicaSet's for a
     * Deployment-owned pod, the StatefulSet's own for a StatefulSet.
     *
     * The cache invalidates on a change to it, which for a Deployment means a
     * new ReplicaSet: a new pod template, and therefore exactly the moment its
     * rendered labels could have changed. A cheaper key would go stale across a
     * `helm upgrade` that bumps the chart version.
     */
    uid: string | undefined;
}

function ownerRefFor(pod: k8s.V1Pod): OwnerRef | null {
    const namespace = pod.metadata?.namespace;
    if (!namespace || !shouldScan(namespace)) return null;

    const { kind, name } = resolveOwner(pod);
    // `null` is an unresolvable chain and `Pod` is a bare pod that owns itself.
    // Neither has a controller object to read.
    if (!kind || kind === "Pod" || !name) return null;

    const refs = pod.metadata?.ownerReferences ?? [];
    const controller = refs.find((r) => r.controller) ?? refs[0];
    return { kind, namespace, name, uid: controller?.uid };
}

export interface OwnerResolution {
    /** Keyed by `ownerKey`. Empty when nothing could be read. */
    owners: Map<string, OwnerMetadata>;
    /**
     * `false` when the agent is not permitted to read controllers at all.
     *
     * A single 403 sets it: RBAC for `deployments: get` is granted or not, and
     * one denial means the whole layer is missing rather than one object being
     * special. The report carries it so the control plane can say "controller
     * metadata not collected" instead of "no Helm release claims these
     * workloads" — the difference between a fact about the cluster and a fact
     * about our collection.
     */
    collected: boolean;
}

export class OwnerMetadataCache {
    private readers: Map<string, Reader>;
    /** `ownerKey` → the uid it was fetched under, and what came back. */
    private cache = new Map<string, { uid: string | undefined; metadata: OwnerMetadata }>();
    /** Set once a 403 proves the RBAC is absent, so the next report does not re-ask. */
    private denied = false;
    /** Counts every `get` actually issued — asserted by the tests. */
    private requests = 0;

    constructor(kc: k8s.KubeConfig) {
        this.readers = readers(kc);
    }

    /** Requests issued since the process started. For logging and for tests. */
    get requestCount(): number {
        return this.requests;
    }

    /**
     * Resolve every distinct controller behind `pods`.
     *
     * Sequential rather than parallel on purpose: this runs once per report on
     * a five-minute timer, and a burst of hundreds of concurrent `get`s against
     * the API server is a worse neighbour than a slow loop nobody is waiting on.
     */
    async resolve(pods: readonly k8s.V1Pod[]): Promise<OwnerResolution> {
        const wanted = new Map<string, OwnerRef>();
        for (const pod of pods) {
            const ref = ownerRefFor(pod);
            if (ref) wanted.set(ownerKey(ref.namespace, ref.kind, ref.name), ref);
        }

        const owners = new Map<string, OwnerMetadata>();
        for (const [key, ref] of wanted) {
            const cached = this.cache.get(key);
            if (cached && cached.uid === ref.uid) {
                owners.set(key, cached.metadata);
                continue;
            }

            const metadata = await this.fetch(ref);
            if (metadata === null) {
                // Denied, or a kind with no reader. Neither is retried within
                // this report, and neither is cached — a 403 that is later
                // fixed by granting the role should take effect on the next
                // report rather than on the next process.
                continue;
            }
            this.cache.set(key, { uid: ref.uid, metadata });
            owners.set(key, metadata);
        }

        return { owners, collected: !this.denied };
    }

    /**
     * One controller's metadata, plus its own controller's where there is a
     * second hop worth taking.
     *
     * `Job → CronJob` is that hop, and it is the same lookup: a Job created by
     * a CronJob carries the chart labels only if the CronJob's `jobTemplate`
     * templated them through, and often it did not. Nothing else needs a second
     * hop — a Deployment's ReplicaSet is already collapsed by `resolveOwner`.
     */
    private async fetch(ref: OwnerRef): Promise<OwnerMetadata | null> {
        const own = await this.get(ref.kind, ref.namespace, ref.name);
        if (!own) return null;

        if (ref.kind !== "Job") return own.metadata;

        const parent = own.controllerRef;
        if (parent?.kind !== "CronJob" || !parent.name) return own.metadata;

        const grand = await this.get("CronJob", ref.namespace, parent.name);
        if (!grand) return own.metadata;

        // Same precedence as pod-over-controller: the nearer object wins, and
        // the further one only fills in what the nearer one never carried.
        return {
            labels: { ...grand.metadata.labels, ...own.metadata.labels },
            annotations: { ...grand.metadata.annotations, ...own.metadata.annotations },
        };
    }

    private async get(
        kind: string,
        namespace: string,
        name: string,
    ): Promise<{ metadata: OwnerMetadata; controllerRef: k8s.V1OwnerReference | undefined } | null> {
        if (this.denied) return null;

        const read = this.readers.get(kind);
        if (!read) return null;

        try {
            this.requests += 1;
            const object = await read(
                name,
                namespace,
                k8s.setHeaderOptions("Accept", PARTIAL_METADATA_ACCEPT),
            );
            const refs = object.metadata?.ownerReferences ?? [];
            return {
                metadata: {
                    labels: pickOwnerLabels(object.metadata?.labels),
                    annotations: pickOwnerAnnotations(object.metadata?.annotations),
                },
                controllerRef: refs.find((r) => r.controller) ?? refs[0],
            };
        } catch (err) {
            const status = err instanceof k8s.ApiException ? err.code : undefined;

            /* One warn line and pod-only attribution for the rest of the
               process, exactly as `resolveRegistryAuth` does for Secrets. The
               resource is named because naming it is the only way an operator
               who upgraded the agent without re-rendering the ClusterRole finds
               out which rule is missing. */
            if (status === 403) {
                this.denied = true;
                log.warn(
                    { kind, namespace, name, status },
                    "not permitted to read workload controllers — Helm and GitOps context will be " +
                    "missing for workloads whose pods do not carry it. Upgrade the chart, or set " +
                    "scanner.resolveWorkloadOwners=false to silence this"
                );
                return null;
            }

            /* 404 is ordinary: a Deployment deleted between the informer's
               snapshot and this read, or a ReplicaSet name inferred from a
               `pod-template-hash` that no longer resolves. Debug, not warn —
               it is not actionable and it happens on every rollout. */
            log.debug(
                { kind, namespace, name, status, err: err instanceof Error ? err.message : String(err) },
                "could not read workload controller — continuing without its metadata"
            );
            return null;
        }
    }
}

/** The lookup a report gets when owner resolution is switched off entirely. */
export const NO_OWNER_METADATA: OwnerResolution = {
    owners: new Map<string, OwnerMetadata>(),
    collected: false,
};
