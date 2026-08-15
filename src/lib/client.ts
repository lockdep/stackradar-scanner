import * as fs from "fs";
import { API_URL, API_KEY, SCANNER_VERSION, CLUSTER_ID, type InventoryReport } from "./scan.js";
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

/**
 * Has this digest already been scanned — by anyone, anywhere.
 *
 * Digest only. The old form also sent `projectName` and `groupName`, which made
 * the answer depend on *where* the image was running: one image in five
 * namespaces was five pulls, five syft runs and five matching passes. A digest
 * is content-addressed, so the bytes are the same wherever they run and the
 * answer cannot depend on who is asking.
 */
export async function checkExistingSbom(imageDigest: string): Promise<boolean> {
    const url = new URL(`${API_URL}/v1/sboms/check`);
    url.searchParams.set("imageDigest", imageDigest);

    log.debug({ imageDigest }, "checking for existing SBOM");
    try {
        const response = await fetchWithRetry(url.toString(), {
            headers: { "X-API-Key": API_KEY! },
        });
        if (!response.ok) return false;
        const data = await response.json() as { exists: boolean };
        const exists = data.exists === true;
        log.debug({ imageDigest, exists }, "existing SBOM check result");
        return exists;
    } catch (err) {
        // A failed check costs a redundant scan, never a missing one.
        log.warn({ imageDigest, err: err instanceof Error ? err.message : String(err) }, "existing SBOM check failed");
        return false;
    }
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/** What the SBOM describes: the bytes. */
export interface UploadImageIdentity {
    imageDigest: string;
    imageRef: string;
    registry: string | undefined;
    repository: string | undefined;
}

/** Where those bytes run. Optional — an SBOM with no cluster behind it is fine. */
export interface UploadWorkloadIdentity {
    namespace: string;
    workloadName: string;
    workloadKind: string | null;
    containerName: string;
    /** Omitted for a digest-pinned deployment. Never invented as `"latest"`. */
    imageTag: string | undefined;
}

/**
 * Upload an SBOM for an image.
 *
 * The two identities are separate parameters, not one `"<workload>/<container>"`
 * string plus a group name. The image identity says what was scanned and is
 * required; the workload identity says where it runs and links the image to the
 * container running it.
 *
 * Note what is no longer sent: pod labels and annotations. They are deployment
 * context, they cannot live on a shareable artefact, and they now ride
 * `POST /v1/inventory` instead — which is also the only payload that can
 * express a mid-rollout Deployment honestly. See
 * `docs/proposals/deployment-context-collection.md`.
 */
export async function uploadSBOM(
    sbomFile: string,
    image: UploadImageIdentity,
    workload: UploadWorkloadIdentity,
): Promise<void> {
    const url = new URL(`${API_URL}/v1/sboms/upload/cyclonedx`);

    url.searchParams.set("imageDigest", image.imageDigest);
    url.searchParams.set("imageRef", image.imageRef);
    if (image.registry) url.searchParams.set("registry", image.registry);
    if (image.repository) url.searchParams.set("repository", image.repository);

    url.searchParams.set("namespace", workload.namespace);
    url.searchParams.set("workloadName", workload.workloadName);
    // Omitted when `ownerReferences` did not resolve. The server stores NULL
    // rather than the literal "Pod", which would produce a wrong remediation
    // command for anything that is not one.
    if (workload.workloadKind) url.searchParams.set("workloadKind", workload.workloadKind);
    url.searchParams.set("containerName", workload.containerName);
    if (workload.imageTag) url.searchParams.set("tag", workload.imageTag);

    const sbomBytes = fs.readFileSync(sbomFile);
    const blob = new Blob([sbomBytes], { type: "application/json" });

    log.info(
        {
            url: url.origin + url.pathname,
            imageDigest: image.imageDigest,
            namespace: workload.namespace,
            workload: workload.workloadName,
            sbomBytes: sbomBytes.byteLength,
        },
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

    /* Another scanner reached this digest first. That is the dedup check
       racing, not a failure: the image is scanned either way, and treating it
       as an error would fill the log with noise on every cold start of a fleet
       that shares base images. */
    if (response.status === 409) {
        log.debug({ imageDigest: image.imageDigest }, "image already has an SBOM, skipping");
        return;
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
    }
}

// ─── Inventory ───────────────────────────────────────────────────────────────

// Defined beside `buildInventory`, which is what produces it.
export type { InventoryReport };

/**
 * Report everything the informer can see.
 *
 * Under ADR 0004 this is no longer only a progress hint — it is the **primary
 * write path** for namespaces, workloads, containers and Helm releases on the
 * control plane. It is still the thing that turns the first minutes (image pull
 * plus syft, before any SBOM exists) from a blank screen into a count that
 * fills in, but now it also carries the deployment context an SBOM must not.
 *
 * The report is the complete set, not a delta: the server replaces the
 * cluster's inventory with it, which is also how a removed workload disappears.
 * Failures are the caller's to log and drop — losing an inventory report must
 * never take down a scanner that is otherwise scanning fine.
 */
export async function reportInventory(report: InventoryReport): Promise<void> {
    const url = `${API_URL}/v1/inventory`;
    const response = await fetchWithRetry(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY!,
        },
        body: JSON.stringify(report),
    });

    // A control plane older than this scanner has no such route, or has one that
    // speaks v1 and rejects this body. Scanners and the server release
    // independently, so both are normal deployment states — log once per
    // interval at a level that does not read as an outage, and keep scanning.
    if (response.status === 404) {
        log.debug("inventory endpoint not available on this control plane, skipping");
        return;
    }
    if (response.status === 400) {
        log.warn({ detail: await response.text() }, "inventory report rejected by control plane, skipping");
        return;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const body = await response.json().catch(() => null) as
        | { accepted?: Record<string, number>; warnings?: { code: string; count?: number }[] }
        | null;

    // Log what *landed*, not what was sent, and surface the warnings —
    // "12 workloads with an unresolved kind" is a coverage caveat, not a
    // detail to bury.
    log.info(
        { accepted: body?.accepted, warnings: body?.warnings },
        "inventory reported",
    );
}
