import * as fs from "fs";
import { API_URL, API_KEY, SCANNER_VERSION, CLUSTER_NAME, CLUSTER_ID, type InventoryWorkload } from "./scan.js";
import { log } from "./logger.js";
import { recordHeartbeatOk, recordHeartbeatFailure } from "./health.js";

// ─── HTTP with retry ─────────────────────────────────────────────────────────

/**
 * Node's built-in fetch (undici) pools keep-alive connections. When a long-
 * running syft scan sits between two requests to the same host the pooled
 * socket gets reaped by the peer (or kube-proxy/conntrack) while the client
 * still considers it healthy. The next fetch writes onto the dead socket and
 * undici rejects with `fetch failed` / cause `other side closed` (sometimes
 * `ECONNRESET` / `UND_ERR_SOCKET` / `socket hang up`). Retrying on a fresh
 * connection almost always succeeds. Safe even for POST because the request
 * never reached the server.
 */
function isTransientFetchError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const cause = (err as NodeJS.ErrnoException).cause as
        | (Error & { code?: string })
        | undefined;
    const code = cause?.code;
    const msg = cause?.message ?? String(cause ?? "");
    return (
        code === "ECONNRESET" ||
        code === "UND_ERR_SOCKET" ||
        code === "ECONNREFUSED" ||
        code === "EPIPE" ||
        msg.includes("other side closed") ||
        msg.includes("socket hang up")
    );
}

async function fetchWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts = 3,
): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("X-Scanner-Version", SCANNER_VERSION);
    const finalInit: RequestInit = { ...init, headers };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fetch(url, finalInit);
        } catch (err) {
            lastErr = err;
            if (attempt === maxAttempts || !isTransientFetchError(err)) throw err;
            const backoffMs = 200 * 2 ** (attempt - 1);
            log.warn(
                {
                    url,
                    attempt,
                    maxAttempts,
                    backoffMs,
                    err: err instanceof Error ? err.message : String(err),
                },
                "transient fetch error, retrying",
            );
            await new Promise((r) => setTimeout(r, backoffMs));
        }
    }
    throw lastErr;
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

/**
 * Reports the agent to the control plane, and records the outcome for
 * `/healthz`.
 *
 * Both failure paths are counted, not just the rejection: a proxy dispatcher
 * pointed at an endpoint that has moved never gets a response at all, and that
 * is precisely the fault a restart clears.
 */
export async function heartbeat(): Promise<void> {
    const url = `${API_URL}/v1/heartbeat`;
    const headers: Record<string, string> = { "X-API-Key": API_KEY! };
    if (CLUSTER_ID) headers["X-Cluster-Id"] = CLUSTER_ID;

    let response: Response;
    try {
        response = await fetchWithRetry(url, { method: "POST", headers });
    } catch (err) {
        recordHeartbeatFailure();
        throw err;
    }

    if (!response.ok) {
        recordHeartbeatFailure();
        throw new Error(`heartbeat rejected by server: HTTP ${response.status} — check API key, API URL, and cluster ID`);
    }

    recordHeartbeatOk();
    log.info("heartbeat ok");
}

// ─── Digest check ────────────────────────────────────────────────────────────

export async function checkExistingSbom(
    imageDigest: string,
    projectName: string,
    groupName: string,
): Promise<boolean> {
    const url = new URL(`${API_URL}/v1/sboms/check`);
    url.searchParams.set("imageDigest", imageDigest);
    url.searchParams.set("projectName", projectName);
    url.searchParams.set("groupName", groupName);

    log.info({ imageDigest, projectName, groupName }, "checking for existing SBOM");
    try {
        const response = await fetchWithRetry(url.toString(), {
            headers: { "X-API-Key": API_KEY! },
        });
        if (!response.ok) return false;
        const data = await response.json() as { exists: boolean };
        const exists = data.exists === true;
        log.info({ imageDigest, projectName, groupName, exists }, "existing SBOM check result");
        return exists;
    } catch (err) {
        log.warn({ imageDigest, projectName, groupName, err: err instanceof Error ? err.message : String(err) }, "existing SBOM check failed");
        return false;
    }
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export async function uploadSBOM(
    sbomFile: string,
    projectName: string,
    tag: string | undefined,
    groupName: string,
    registry: string | undefined,
    imageDigest: string | undefined,
    imageRef: string,
    workloadKind: string | undefined,
    extraLabels?: Record<string, string>,
    extraAnnotations?: Record<string, string>,
): Promise<void> {
    const url = new URL(`${API_URL}/v1/sboms/upload/cyclonedx`);
    url.searchParams.set("projectName", projectName);
    // Omitted entirely for a digest-pinned image — the server stores NULL and
    // the UI shows the digest instead of a tag nobody deployed.
    if (tag) url.searchParams.set("tag", tag);
    url.searchParams.set("groupName", groupName);
    url.searchParams.set("groupLabels", JSON.stringify({ type: "namespace" }));
    if (registry) url.searchParams.set("registry", registry);
    if (imageDigest) url.searchParams.set("imageDigest", imageDigest);
    url.searchParams.set("imageRef", imageRef);

    const projectLabels: Record<string, string> = { type: "container-image" };
    if (workloadKind) projectLabels.workloadKind = workloadKind;
    url.searchParams.set("projectLabels", JSON.stringify(projectLabels));

    // Merge labels + annotations into a single labels bag. The allowlists are
    // disjoint by key (Helm sets `helm.sh/chart` as a label, `meta.helm.sh/*`
    // as annotations) so this avoids any DB schema change while keeping the
    // useful breadcrumbs queryable in `sboms.labels`.
    const labels: Record<string, string> = { ...extraLabels, ...extraAnnotations };
    if (CLUSTER_NAME) labels.cluster = CLUSTER_NAME;
    if (CLUSTER_ID) labels.clusterId = CLUSTER_ID;
    if (Object.keys(labels).length > 0) {
        url.searchParams.set("labels", JSON.stringify(labels));
    }

    url.searchParams.set("isCurrent", "true");

    const sbomBytes = fs.readFileSync(sbomFile);
    const blob = new Blob([sbomBytes], { type: "application/json" });

    log.info(
        { url: url.origin + url.pathname, projectName, groupName, sbomBytes: sbomBytes.byteLength },
        "uploading SBOM",
    );

    const response = await fetchWithRetry(url.toString(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY!,
        },
        body: blob,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }
}

// ─── Inventory ───────────────────────────────────────────────────────────────

// Defined beside `buildInventory`, which is what produces it.
export type { InventoryWorkload };

/**
 * Reports every workload currently running, ahead of scanning any of them.
 *
 * The informer knows the whole cluster within seconds of startup, while image
 * pull plus syft takes minutes for a large fleet — this is what lets the
 * Dashboard show "47 discovered, 6 scanned, 41 in progress" instead of nothing
 * at all until the first SBOM lands.
 *
 * The report is the complete set, not a delta: the server replaces the
 * cluster's inventory with it, which is also how a removed workload disappears.
 * Failures are the caller's to log and drop — an inventory report is a progress
 * hint, and must never take down a scanner that is otherwise scanning fine.
 */
export async function reportInventory(workloads: InventoryWorkload[]): Promise<void> {
    const url = `${API_URL}/v1/inventory`;
    const response = await fetchWithRetry(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY!,
        },
        body: JSON.stringify({ workloads }),
    });

    // A control plane older than this scanner has no such route. Scanners and
    // the server are released independently, so that is a normal deployment
    // state and not something to warn about on every interval.
    if (response.status === 404) {
        log.debug("inventory endpoint not available on this control plane, skipping");
        return;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    log.info({ workloads: workloads.length }, "inventory reported");
}
