import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";

/**
 * The cluster's Kubernetes version, for the `X-Kubernetes-Version` heartbeat
 * header. The server uses it to warn when a suggested chart version's
 * `kubeVersion` constraint excludes this cluster.
 *
 * Read from `/version` — part of the discovery surface every authenticated
 * principal can reach, so this needs no RBAC beyond what the agent already
 * has. Refreshed on the heartbeat cadence (control planes upgrade underneath
 * long-lived agents); a failed read keeps the last successful value, and
 * until one succeeds there is nothing to send — the header stays absent
 * rather than carrying a guess, and an absent header never erases what the
 * server already knows.
 */

let cached: string | null = null;

export async function refreshClusterVersion(kc: k8s.KubeConfig): Promise<void> {
    try {
        const info = await kc.makeApiClient(k8s.VersionApi).getCode();
        if (info.gitVersion) cached = info.gitVersion;
    } catch (err) {
        // Never fails the caller: version reporting is decoration on the
        // heartbeat, not a condition of it.
        log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "could not read cluster version",
        );
    }
}

/** Last successfully read `gitVersion` (e.g. `v1.29.4+k3s1`), or null. */
export function clusterVersion(): string | null {
    return cached;
}

/** Test hook: reset the module-level cache between cases. */
export function resetClusterVersion(): void {
    cached = null;
}
