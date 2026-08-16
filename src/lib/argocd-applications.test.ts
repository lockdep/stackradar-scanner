import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";
import { ArgocdApplicationCache, primarySource, toInventoryApplication } from "./argocd-applications.js";
import { applicationKey } from "./scan.js";

function fakeKubeConfig(result: unknown, error?: unknown) {
    let calls = 0;
    const api = {
        listNamespacedCustomObject: async () => {
            calls += 1;
            if (error) throw error;
            return result;
        },
    };
    return {
        kc: { makeApiClient: () => api } as unknown as k8s.KubeConfig,
        calls: () => calls,
    };
}

describe("primarySource", () => {
    /*
     * `spec.sources` — plural — is the shape in use on the reference cluster,
     * and three of its six Applications would be missed by reading only the
     * singular field.
     */
    it("reads the plural sources array", () => {
        expect(primarySource({
            spec: {
                sources: [{ repoURL: "https://charts.example.com", chart: "redis", targetRevision: "18.2.1" }],
            },
        })).toMatchObject({ chart: "redis" });
    });

    it("still reads the singular source", () => {
        expect(primarySource({
            spec: { source: { repoURL: "https://github.com/acme/infra", path: "apps/api" } },
        })).toMatchObject({ path: "apps/api" });
    });

    /*
     * A multi-source app is typically one chart source plus one values
     * repository. The values repository is a `ref` that describes nothing about
     * the deployed artefact, and reporting it would name the wrong origin.
     */
    it("prefers the chart source and skips a values ref", () => {
        expect(primarySource({
            spec: {
                sources: [
                    { repoURL: "https://github.com/acme/values", ref: "values" },
                    { repoURL: "https://charts.example.com", chart: "redis" },
                ],
            },
        })).toMatchObject({ chart: "redis" });
    });

    it("returns null when nothing names a repository", () => {
        expect(primarySource({ spec: {} })).toBeNull();
        expect(primarySource({ spec: { sources: [{ ref: "values", repoURL: "x" }] } })).toBeNull();
    });
});

describe("toInventoryApplication", () => {
    it("fills the row from the Application object", () => {
        expect(toInventoryApplication({
            metadata: { name: "kube-prometheus-stack", namespace: "argocd" },
            spec: {
                sources: [{
                    chart: "kube-prometheus-stack",
                    repoURL: "https://prometheus-community.github.io/helm-charts",
                    targetRevision: "82.18.0",
                }],
                destination: { namespace: "monitoring" },
            },
        })).toEqual({
            name: "kube-prometheus-stack",
            namespace: "argocd",
            tool: "argocd",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
            targetRevision: "82.18.0",
            chart: "kube-prometheus-stack",
            path: null,
            destinationNamespace: "monitoring",
        });
    });

    /* A CR's schema is the Argo project's to change. A malformed one must cost
       its own repository URL, not the whole inventory report. */
    it("reports nulls rather than throwing on a shape it does not recognise", () => {
        expect(toInventoryApplication({
            metadata: { name: "app", namespace: "argocd" },
            spec: { sources: [{ repoURL: 42, chart: null }] as never },
        })).toMatchObject({ repoUrl: null, chart: null, targetRevision: null });
    });

    it("returns null for an object with no identity", () => {
        expect(toInventoryApplication({ metadata: { name: "app" } })).toBeNull();
    });
});

describe("ArgocdApplicationCache", () => {
    it("keys the applications the way the report looks them up", async () => {
        const { kc } = fakeKubeConfig({
            items: [{
                metadata: { name: "payments", namespace: "argocd" },
                spec: { source: { repoURL: "https://github.com/acme/infra", path: "apps/payments" } },
            }],
        });

        const applications = await new ArgocdApplicationCache(kc, "argocd").list();

        expect(applications.get(applicationKey("argocd", "payments"))).toMatchObject({
            repoUrl: "https://github.com/acme/infra",
            path: "apps/payments",
        });
    });

    /*
     * The overwhelmingly common case: no ArgoCD at all. One 404 answers it for
     * the life of the process, and it is not a warning — nothing is wrong.
     */
    it("asks once on a cluster with no ArgoCD CRD", async () => {
        const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
        const { kc, calls } = fakeKubeConfig(null, new k8s.ApiException(404, "not found", {}, {}));

        const cache = new ArgocdApplicationCache(kc, "argocd");
        expect((await cache.list()).size).toBe(0);
        expect((await cache.list()).size).toBe(0);

        expect(calls()).toBe(1);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    describe("when the list is denied", () => {
        let warn: ReturnType<typeof vi.spyOn>;
        beforeEach(() => { warn = vi.spyOn(log, "warn").mockImplementation(() => {}); });
        afterEach(() => { warn.mockRestore(); });

        /* Degrades to the tracking annotation alone: the delivery layer is
           still reported, it simply carries no repository URL. */
        it("warns once and returns nothing", async () => {
            const { kc, calls } = fakeKubeConfig(null, new k8s.ApiException(403, "forbidden", {}, {}));

            const cache = new ArgocdApplicationCache(kc, "argocd");
            expect((await cache.list()).size).toBe(0);
            expect((await cache.list()).size).toBe(0);

            expect(calls()).toBe(1);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]![1]).toContain("scanner.argocdNamespace");
        });
    });
});
