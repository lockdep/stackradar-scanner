import * as fs from "fs";
import { API_URL, API_KEY, SCANNER_VERSION, CLUSTER_ID, type InventoryReport } from "./scan.js";
import { log } from "./logger.js";
import { recordHeartbeatOk, recordHeartbeatFailure, recordHeartbeatNotice } from "./health.js";
import { clusterVersion } from "./cluster-version.js";

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

/**
 * Longest the agent will sit out on a `Retry-After`. A control plane shedding
 * load asks for seconds, not hours; a value past this is treated as "come back
 * later" and the caller's own retry path (the sweep, the next heartbeat tick)
 * takes over rather than a request hanging for the rest of the day.
 */
export const MAX_RETRY_AFTER_MS = parseInt(process.env.MAX_RETRY_AFTER_MS ?? "60000", 10);

/**
 * Milliseconds to wait before retrying a 429 / 503, from its `Retry-After`
 * header — seconds or an HTTP date — or a default when the server sent none.
 * `undefined` means the server asked for longer than this agent is willing to
 * block, and the caller should treat the request as deferred, not failed.
 */
export function retryAfterMs(response: Response, now: number = Date.now()): number | undefined {
    const raw = response.headers.get("retry-after");
    let ms: number;
    if (raw === null || raw.trim() === "") {
        ms = 5000;
    } else if (/^\d+$/.test(raw.trim())) {
        ms = parseInt(raw.trim(), 10) * 1000;
    } else {
        const at = Date.parse(raw);
        ms = Number.isNaN(at) ? 5000 : Math.max(0, at - now);
    }
    return ms <= MAX_RETRY_AFTER_MS ? ms : undefined;
}

/** What a server says when it wants the fleet to slow down. */
export function isBackpressure(status: number): boolean {
    return status === 429 || status === 503;
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
            const response = await fetch(url, finalInit);
            /* 429 / 503 are the control plane asking a whole fleet to back off
               at once. Honouring `Retry-After` here is what keeps a thousand
               agents from turning one overloaded minute into a thundering herd;
               the last attempt is returned as-is so the caller can decide what
               "still rate-limited" means for *its* request. */
            if (isBackpressure(response.status) && attempt < maxAttempts) {
                const waitMs = retryAfterMs(response);
                if (waitMs === undefined) return response;
                log.warn({ url, status: response.status, attempt, maxAttempts, waitMs }, "server asked us to back off, waiting");
                await response.body?.cancel().catch(() => {});
                await new Promise((r) => setTimeout(r, waitMs));
                continue;
            }
            return response;
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
 * A heartbeat the server answered but did not accept. `status` is what lets
 * the startup path tell a credential problem (fatal — nothing will change
 * without a re-render) from a control plane that is mid-deploy (retry — it
 * will be back in a minute).
 */
export class HeartbeatRejectedError extends Error {
    constructor(public readonly status: number) {
        super(`heartbeat rejected by server: HTTP ${status}` + (status === 401 || status === 403
            ? " — check API key, API URL, and cluster ID"
            : ""));
        this.name = "HeartbeatRejectedError";
    }
    /** 401 / 403: wrong key, wrong cluster, revoked. Retrying cannot help. */
    get isAuthFailure(): boolean {
        return this.status === 401 || this.status === 403;
    }
}

/**
 * What the control plane says back. Every field beyond `ok` is optional and
 * additive: a server that predates them answers `{ok:true}` and the agent
 * behaves as before. This is the only channel the server has to a running
 * fleet — there is no push — so it is where "upgrade", "slow down" and "this
 * version is deprecated" arrive.
 */
export interface HeartbeatResponse {
    ok: boolean;
    /** Oldest scanner version the server still fully supports. */
    minScannerVersion?: string;
    /** Free-text notice for the operator, logged at warn on every heartbeat. */
    message?: string;
}

/** Last heartbeat response, for `/healthz` and for tests. */
let lastHeartbeatResponse: HeartbeatResponse | undefined;
export function lastHeartbeat(): HeartbeatResponse | undefined {
    return lastHeartbeatResponse;
}

/**
 * `a < b` for dotted numeric versions with an optional prerelease suffix,
 * which is all a scanner version ever is. Anything unparseable ("unknown",
 * a dev build) compares as never-older, so a local build is never told to
 * upgrade.
 */
export function isOlderVersion(a: string, b: string): boolean {
    const parse = (v: string) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return false;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] < pb[i];
    }
    return false;
}

/**
 * Reports the agent to the control plane, and records the outcome for
 * `/healthz`.
 *
 * Both failure paths are counted, not just the rejection: a proxy dispatcher
 * pointed at an endpoint that has moved never gets a response at all, and that
 * is precisely the fault a restart clears.
 */
export async function heartbeat(): Promise<HeartbeatResponse> {
    const url = `${API_URL}/v1/heartbeat`;
    const headers: Record<string, string> = { "X-API-Key": API_KEY! };
    if (CLUSTER_ID) headers["X-Cluster-Id"] = CLUSTER_ID;
    // On the heartbeat only, not injected into every request: the server
    // records it from this endpoint, and a version we never managed to read
    // sends nothing rather than a guess.
    const kubeVersion = clusterVersion();
    if (kubeVersion) headers["X-Kubernetes-Version"] = kubeVersion;

    let response: Response;
    try {
        response = await fetchWithRetry(url, { method: "POST", headers });
    } catch (err) {
        recordHeartbeatFailure();
        throw err;
    }

    if (!response.ok) {
        recordHeartbeatFailure();
        throw new HeartbeatRejectedError(response.status);
    }

    recordHeartbeatOk();
    const body = await response.json().catch(() => ({ ok: true })) as HeartbeatResponse;
    lastHeartbeatResponse = body;
    recordHeartbeatNotice(body);

    if (body.message) {
        log.warn({ message: body.message }, "notice from control plane");
    }
    if (body.minScannerVersion && isOlderVersion(SCANNER_VERSION, body.minScannerVersion)) {
        log.warn(
            { running: SCANNER_VERSION, minScannerVersion: body.minScannerVersion },
            "this scanner version is older than the control plane supports — upgrade the stackradar-scanner chart",
        );
    }
    log.info("heartbeat ok");
    return body;
}

// ─── Digest check ────────────────────────────────────────────────────────────

/** Three answers, because "the server did not say" is not "no". */
export type SbomCheck = "exists" | "missing" | "unknown";

/**
 * Has **this cluster** already scanned this digest.
 *
 * Digest only. The old form also sent `projectName` and `groupName`, which made
 * the answer depend on *where* the image was running: one image in five
 * namespaces was five pulls, five syft runs and five matching passes. A digest
 * is content-addressed, so the bytes are the same wherever they run. The
 * server scopes the answer to the key's cluster (ADR 0006), so nothing about
 * another tenant's images is learnable from it.
 *
 * `unknown` — a 429, a 5xx, a network failure — is deliberately distinct from
 * `missing`. Treating it as "not scanned" turned a rate-limited minute into a
 * full re-pull and re-scan of every image in the cluster; the caller defers
 * instead and asks again on the next event or sweep.
 */
export async function checkExistingSbom(imageDigest: string): Promise<SbomCheck> {
    const url = new URL(`${API_URL}/v1/sboms/check`);
    url.searchParams.set("imageDigest", imageDigest);

    log.debug({ imageDigest }, "checking for existing SBOM");
    try {
        const response = await fetchWithRetry(url.toString(), {
            headers: { "X-API-Key": API_KEY! },
        });
        if (!response.ok) {
            if (isBackpressure(response.status) || response.status >= 500) {
                log.warn({ imageDigest, status: response.status }, "existing SBOM check deferred by server");
                return "unknown";
            }
            // A 4xx is an answer about this request, not about the server's
            // health: scan, and let the upload report what is wrong.
            log.warn({ imageDigest, status: response.status }, "existing SBOM check rejected, scanning anyway");
            return "missing";
        }
        const data = await response.json() as { exists: boolean };
        const exists = data.exists === true;
        log.debug({ imageDigest, exists }, "existing SBOM check result");
        return exists ? "exists" : "missing";
    } catch (err) {
        log.warn({ imageDigest, err: err instanceof Error ? err.message : String(err) }, "existing SBOM check failed, deferring");
        return "unknown";
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
        throw new UploadRejectedError(response.status, text);
    }
}

/**
 * An upload the server answered with a non-2xx. `retryable` is the caller's
 * cue for whether the digest goes back in the queue: a 400 is about this SBOM
 * and will not change; a 429 or a 502 is about this minute.
 */
export class UploadRejectedError extends Error {
    constructor(public readonly status: number, detail: string) {
        super(`HTTP ${status}: ${detail}`);
        this.name = "UploadRejectedError";
    }
    get retryable(): boolean {
        return isBackpressure(this.status) || this.status >= 500;
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

    /* A control plane older than this scanner has no such route. Scanners and
       the server release independently, so that is a normal deployment state
       and it must not stop the SBOM uploads — but it is `warn`, not `debug`.
       Inventory is the primary write path for namespaces, workloads, releases
       and every label on them; at `debug` a 404 is invisible in a default
       install, and the agent looks perfectly healthy while the entire
       deployment side of the model silently never lands. That is exactly how a
       route missing from an ingress allowlist went unnoticed. */
    if (response.status === 404) {
        log.warn(
            { url },
            "inventory endpoint returned 404 — no deployment context (namespaces, workloads, Helm releases) will be recorded; check the control plane version and that the route is reachable through your ingress",
        );
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
