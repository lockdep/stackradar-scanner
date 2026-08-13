import * as http from "node:http";
import { log } from "./logger.js";

// ─── Config ──────────────────────────────────────────────────────────────────

// Set by the chart from `watcher.healthPort`. Not a Service — the kubelet
// reaches it on the pod IP and nothing else should.
export const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? "8081", 10);

/** How long `watch.ts` waits before restarting an informer that errored. */
export const INFORMER_RESTART_DELAY_MS = 5000;

/**
 * How long the informer may stay down before liveness fails.
 *
 * Three restart attempts' worth. A single failed restart is routine — an API
 * server rolling, a watch expiring mid-upgrade — and must not restart the pod;
 * three in a row is a fault that a restart has a chance of clearing (a stale
 * token, a dispatcher pointed at a proxy that has moved).
 */
export const INFORMER_DOWN_GRACE_MS = INFORMER_RESTART_DELAY_MS * 3;

/**
 * Consecutive heartbeat failures before liveness fails.
 *
 * At the default five-minute heartbeat this is ~25 minutes of no contact with
 * the control plane, deliberately far longer than any deploy of ours. A
 * restart cannot fix an outage on our side, and a threshold low enough to fire
 * during one would restart every agent in every customer cluster at exactly
 * the wrong moment. What it does catch is the failure that is local to the
 * pod — a dead proxy dispatcher, a DNS answer cached against a moved
 * endpoint — where a fresh process genuinely does recover.
 */
export const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 5;

// ─── State ───────────────────────────────────────────────────────────────────

interface HealthState {
    /** False between an informer 'error' and the next successful start. */
    informerRunning: boolean;
    /** When the informer went down, or null if it is up (or has never started). */
    informerDownSince: number | null;
    /** Set once the informer's first list+watch has succeeded. Never unset. */
    initialSyncComplete: boolean;
    /** Diagnostics only — deliberately not a liveness input, see below. */
    lastInformerEventAt: number | null;
    lastHeartbeatOkAt: number | null;
    consecutiveHeartbeatFailures: number;
}

function initialState(): HealthState {
    return {
        informerRunning: false,
        informerDownSince: null,
        initialSyncComplete: false,
        lastInformerEventAt: null,
        lastHeartbeatOkAt: null,
        consecutiveHeartbeatFailures: 0,
    };
}

let state = initialState();

/**
 * Counts informer errors, so a start attempt can tell whether it actually
 * succeeded. See `markInformerUp`.
 */
let informerErrorCount = 0;

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Opens a start attempt, returning a token to pass to `markInformerUp`.
 *
 * `ListWatch.start()` resolves whether or not the initial list succeeded: a
 * failed list is reported by emitting 'error' and returning, not by rejecting.
 * So "start() resolved" is not evidence the informer is watching anything, and
 * treating it as such is what makes the failure this whole module exists for
 * invisible — every failed restart would clear `informerDownSince`, the grace
 * window would never elapse, and the probe could never fire.
 *
 * The token closes that gap: if an error arrived between the attempt opening
 * and closing, the attempt did not succeed, whatever `start()` returned.
 */
export function beginInformerStart(): number {
    return informerErrorCount;
}

/** Closes a start attempt. Returns whether the informer is now considered up. */
export function markInformerUp(attempt: number): boolean {
    if (attempt !== informerErrorCount) return false;
    state.informerRunning = true;
    state.informerDownSince = null;
    state.initialSyncComplete = true;
    return true;
}

/**
 * Records that the informer has stopped watching.
 *
 * `informerDownSince` is not overwritten while already down: the grace window
 * measures one continuous outage, and a restart that fails every five seconds
 * would otherwise reset the clock forever.
 */
export function markInformerDown(): void {
    informerErrorCount++;
    state.informerRunning = false;
    if (state.informerDownSince === null) state.informerDownSince = Date.now();
}

export function recordInformerEvent(): void {
    state.lastInformerEventAt = Date.now();
}

export function recordHeartbeatOk(): void {
    state.lastHeartbeatOkAt = Date.now();
    state.consecutiveHeartbeatFailures = 0;
}

export function recordHeartbeatFailure(): void {
    state.consecutiveHeartbeatFailures++;
}

/** A copy, for tests and for the probe response body. */
export function healthSnapshot(): Readonly<HealthState> {
    return { ...state };
}

/** Test seam. The module's state is process-wide by design. */
export function resetHealthState(): void {
    state = initialState();
    informerErrorCount = 0;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

export interface HealthResult {
    ok: boolean;
    reason?: string;
}

/**
 * Liveness: is this process still doing its job.
 *
 * Deliberately *not* an input: how long since the last pod event. A cluster
 * whose workloads have not changed all night produces no events and is
 * perfectly healthy; an agent restarted for being quiet would be a worse
 * failure than the one this replaces.
 *
 * Also not an input: startup. `informerDownSince` is null until the first
 * error, so a slow initial sync reads as live rather than as a crash loop —
 * which is why the server binds before the informer starts.
 */
export function checkLiveness(now: number = Date.now()): HealthResult {
    if (state.informerDownSince !== null) {
        const downMs = now - state.informerDownSince;
        if (downMs >= INFORMER_DOWN_GRACE_MS) {
            return {
                ok: false,
                reason: `informer has not been watching for ${downMs}ms, over the ${INFORMER_DOWN_GRACE_MS}ms grace window`,
            };
        }
    }

    if (state.consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
        return {
            ok: false,
            reason: `${state.consecutiveHeartbeatFailures} consecutive heartbeat failures, at or over the limit of ${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}`,
        };
    }

    return { ok: true };
}

/** Readiness: has the informer's first sync completed. */
export function checkReadiness(): HealthResult {
    if (!state.initialSyncComplete) {
        return { ok: false, reason: "initial informer sync has not completed" };
    }
    return { ok: true };
}

// ─── Server ──────────────────────────────────────────────────────────────────

function iso(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
}

/**
 * The body is for whoever is holding the incident, not for the kubelet — which
 * reads the status code and nothing else. `kubectl exec … wget -qO- :8081/healthz`
 * should say why in one screen.
 */
function respond(res: http.ServerResponse, result: HealthResult): void {
    const s = state;
    const body = JSON.stringify(
        {
            status: result.ok ? "ok" : "unhealthy",
            ...(result.reason ? { reason: result.reason } : {}),
            informerRunning: s.informerRunning,
            initialSyncComplete: s.initialSyncComplete,
            informerDownSince: iso(s.informerDownSince),
            lastInformerEventAt: iso(s.lastInformerEventAt),
            lastHeartbeatOkAt: iso(s.lastHeartbeatOkAt),
            consecutiveHeartbeatFailures: s.consecutiveHeartbeatFailures,
        },
        null,
        2,
    );
    res.writeHead(result.ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(body);
}

function handleHealthRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? "").split("?")[0];

    if (path === "/healthz" || path === "/readyz") {
        const result = path === "/healthz" ? checkLiveness() : checkReadiness();
        if (!result.ok) log.warn({ probe: path, reason: result.reason }, "health probe failing");
        respond(res, result);
        return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", paths: ["/healthz", "/readyz"] }));
}

/**
 * Binds the probe endpoints.
 *
 * Rejects rather than falling back to another port if the bind fails: a health
 * server on a port the chart did not name is a probe that fails for a reason
 * having nothing to do with the agent's health, which is the class of bug this
 * change exists to remove.
 *
 * No host is passed. Node then binds the unspecified address — `::` with
 * dual-stack where the kernel offers it, `0.0.0.0` otherwise — so the kubelet
 * reaches the pod on whichever family the cluster runs.
 */
export function startHealthServer(port: number = HEALTH_PORT): Promise<http.Server> {
    return new Promise((resolve, reject) => {
        // 0 means "whatever the OS has free", which only the tests pass. The
        // chart cannot set it: `values.schema.json` constrains `healthPort` to
        // 1024–65535, the range a pod with every capability dropped can bind.
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            reject(new Error(`HEALTH_PORT must be a port number, got ${JSON.stringify(process.env.HEALTH_PORT ?? port)}`));
            return;
        }

        const server = http.createServer(handleHealthRequest);

        server.once("error", reject);
        server.listen(port, () => {
            server.removeListener("error", reject);
            // Past the bind, an error is a socket-level problem on one probe
            // request. Logging it beats an uncaught exception that takes down
            // an otherwise working agent.
            server.on("error", (err) =>
                log.warn({ err: err instanceof Error ? err.message : String(err) }, "health server error"),
            );
            const address = server.address();
            log.info(
                {
                    port: typeof address === "object" && address !== null ? address.port : port,
                    paths: ["/healthz", "/readyz"],
                },
                "health server listening",
            );
            resolve(server);
        });
    });
}
