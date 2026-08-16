import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";
import { applicationKey, InventoryApplication } from "./scan.js";

/**
 * Reading ArgoCD `Application` objects for the half of the delivery layer the
 * tracking annotation cannot carry.
 *
 * `argocd.argoproj.io/tracking-id` names the app. The `Application` says where
 * it comes from — `repoURL`, `chart` and `targetRevision` — and that is the
 * only source in the cluster for a release's repository URL, which is `null`
 * for every release collected from labels alone. It is also the fix path: for
 * an Argo user the remediation for a vulnerable chart is a `targetRevision`
 * bump, and the CR says where to make it.
 *
 * **A list, not an informer.** The same argument as `owner-cache.ts`: this is a
 * handful of objects that change on a git push, read once per inventory report
 * on a five-minute timer. A watch would buy nothing and cost a reconnect loop.
 * The RBAC is `list` in one namespace, and nothing else.
 *
 * **Guarded on the CRD existing.** On a cluster with no ArgoCD the list 404s,
 * which is the CRD-absent signal — no discovery call needed, and no repeated
 * asking once the answer is known.
 */

const ARGOCD_GROUP = "argoproj.io";
const ARGOCD_VERSION = "v1alpha1";
const ARGOCD_PLURAL = "applications";

/**
 * The shape read off an `Application`, spelled loosely on purpose.
 *
 * A CR is not a typed object to this client and its schema is the Argo
 * project's to change. Every field is read defensively and a missing one lands
 * as `null` rather than throwing — a malformed `Application` must cost its own
 * repository URL, not the whole inventory report.
 */
interface ArgoSource {
    repoURL?: unknown;
    chart?: unknown;
    path?: unknown;
    targetRevision?: unknown;
    /**
     * Present on a source that only supplies values files to another source.
     * Skipped: it is a reference, not the thing being deployed, and reading it
     * would report the values repository as the chart's origin.
     */
    ref?: unknown;
}

interface ArgoApplication {
    metadata?: { name?: unknown; namespace?: unknown };
    spec?: {
        source?: ArgoSource;
        /** Multi-source apps. The shape in use on the reference cluster. */
        sources?: ArgoSource[];
        destination?: { namespace?: unknown };
    };
}

const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

/**
 * The source that describes what is deployed.
 *
 * `spec.sources` — plural — is the shape a multi-source app uses, and reading
 * only the singular `spec.source` misses them entirely; three of six
 * `Application` objects on the reference cluster are multi-source. Among
 * several, the one carrying a `chart` wins: a multi-source app is typically one
 * chart source plus one values repository, and the values repository is a
 * `ref` that describes nothing about the deployed artefact.
 */
export function primarySource(app: ArgoApplication): ArgoSource | null {
    const sources = app.spec?.sources ?? (app.spec?.source ? [app.spec.source] : []);
    const usable = sources.filter((s) => !s.ref && str(s.repoURL));
    return usable.find((s) => str(s.chart)) ?? usable[0] ?? null;
}

/** One `Application` object as the report's application row. */
export function toInventoryApplication(app: ArgoApplication): InventoryApplication | null {
    const name = str(app.metadata?.name);
    const namespace = str(app.metadata?.namespace);
    if (!name || !namespace) return null;

    const source = primarySource(app);

    /* `spec.source.helm.releaseName` is deliberately not read. It names the
       Helm release the app renders, and it is tempting as a join back to
       `releases[]` — but the workload's own labels already answer that, and a
       second, disagreeing source of release identity is how one release becomes
       two. The two layers meet on the workload, which references both. */
    return {
        name,
        namespace,
        tool: "argocd",
        repoUrl: str(source?.repoURL),
        targetRevision: str(source?.targetRevision),
        chart: str(source?.chart),
        path: str(source?.path),
        destinationNamespace: str(app.spec?.destination?.namespace),
    };
}

export class ArgocdApplicationCache {
    private api: k8s.CustomObjectsApi;
    /**
     * Set once a 404 proves the CRD is not installed, or a 403 proves the RBAC
     * is not granted. Either way the answer will not change without a restart
     * or a re-render, and asking again every five minutes logs noise forever.
     */
    private unavailable = false;

    constructor(kc: k8s.KubeConfig, private namespace: string) {
        this.api = kc.makeApiClient(k8s.CustomObjectsApi);
    }

    /**
     * Every `Application` in the configured namespace, keyed by
     * {@link applicationKey}.
     *
     * Empty on any failure. An empty map is not a claim that no app delivers
     * anything — the tracking annotation still produces application rows
     * without it, they simply carry no repository URL.
     */
    async list(): Promise<ReadonlyMap<string, InventoryApplication>> {
        const applications = new Map<string, InventoryApplication>();
        if (this.unavailable) return applications;

        try {
            const response = (await this.api.listNamespacedCustomObject({
                group: ARGOCD_GROUP,
                version: ARGOCD_VERSION,
                namespace: this.namespace,
                plural: ARGOCD_PLURAL,
            })) as { items?: ArgoApplication[] };

            for (const item of response.items ?? []) {
                const application = toInventoryApplication(item);
                if (!application) continue;
                applications.set(
                    applicationKey(application.namespace, application.name),
                    application
                );
            }
        } catch (err) {
            const status = err instanceof k8s.ApiException ? err.code : undefined;

            /* 404 is the ordinary case, not a failure: no ArgoCD on this
               cluster. Debug, and never asked again. */
            if (status === 404) {
                this.unavailable = true;
                log.debug(
                    { namespace: this.namespace },
                    "no ArgoCD Application CRD in this cluster — GitOps delivery will be reported " +
                    "from pod tracking annotations alone, without repository URLs"
                );
                return applications;
            }

            this.unavailable = true;
            log.warn(
                {
                    namespace: this.namespace,
                    status,
                    err: err instanceof Error ? err.message : String(err),
                },
                status === 403
                    ? "not permitted to list ArgoCD Applications — repository URLs and target " +
                      "revisions will be missing. Grant the rule, point scanner.argocdNamespace at " +
                      "the right namespace, or set scanner.resolveArgocdApplications=false"
                    : "could not list ArgoCD Applications — continuing without repository URLs"
            );
        }

        return applications;
    }
}
