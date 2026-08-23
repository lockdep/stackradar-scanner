import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { clusterVersion, refreshClusterVersion, resetClusterVersion } from "./cluster-version.js";
import { heartbeat } from "./client.js";
import { resetHealthState } from "./health.js";

/**
 * The version read and its header. The load-bearing cases are the negatives:
 * a failed read never throws out of `refreshClusterVersion`, never loses the
 * last known value, and a version we never read sends no header — the server
 * treats an absent header as "leave what you know alone".
 */

function fakeKubeConfig(behaviour: { gitVersion?: string; error?: unknown }) {
    const api = {
        getCode: async () => {
            if (behaviour.error) throw behaviour.error;
            return { gitVersion: behaviour.gitVersion, major: "1", minor: "29" };
        },
    };
    return { makeApiClient: () => api } as unknown as k8s.KubeConfig;
}

beforeEach(() => {
    resetClusterVersion();
    resetHealthState();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("refreshClusterVersion", () => {
    it("caches the gitVersion from /version", async () => {
        await refreshClusterVersion(fakeKubeConfig({ gitVersion: "v1.29.4+k3s1" }));
        expect(clusterVersion()).toBe("v1.29.4+k3s1");
    });

    it("keeps the last known value across a failed refresh, and never throws", async () => {
        await refreshClusterVersion(fakeKubeConfig({ gitVersion: "v1.29.4" }));
        await expect(
            refreshClusterVersion(fakeKubeConfig({ error: new Error("apiserver away") })),
        ).resolves.toBeUndefined();
        expect(clusterVersion()).toBe("v1.29.4");
    });

    it("stays null when no read has ever succeeded", async () => {
        await refreshClusterVersion(fakeKubeConfig({ error: new Error("rbac") }));
        expect(clusterVersion()).toBeNull();
    });
});

describe("heartbeat header plumbing", () => {
    function stubFetch() {
        const seen: Array<{ url: string; headers: Headers }> = [];
        vi.stubGlobal(
            "fetch",
            async (url: string | URL | Request, init?: RequestInit) => {
                seen.push({ url: String(url), headers: new Headers(init?.headers) });
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            },
        );
        return seen;
    }

    it("sends X-Kubernetes-Version once a read has succeeded", async () => {
        const seen = stubFetch();
        await refreshClusterVersion(fakeKubeConfig({ gitVersion: "v1.30.2-gke.1100" }));
        await heartbeat();

        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toContain("/v1/heartbeat");
        expect(seen[0]!.headers.get("X-Kubernetes-Version")).toBe("v1.30.2-gke.1100");
    });

    it("sends no version header when the version was never read", async () => {
        const seen = stubFetch();
        await heartbeat();

        expect(seen).toHaveLength(1);
        expect(seen[0]!.headers.has("X-Kubernetes-Version")).toBe(false);
        // The rest of the heartbeat is untouched by the failure to read.
        expect(seen[0]!.headers.has("X-API-Key")).toBe(true);
    });
});
