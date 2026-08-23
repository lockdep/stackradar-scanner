import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { log } from "./logger.js";
import {
    INFORMER_DOWN_GRACE_MS,
    MAX_CONSECUTIVE_HEARTBEAT_FAILURES,
    beginInformerStart,
    markInformerUp,
    markInformerDown,
    recordInformerEvent,
    recordHeartbeatOk,
    recordHeartbeatFailure,
    checkLiveness,
    checkReadiness,
    healthSnapshot,
    resetHealthState,
    startHealthServer,
} from "./health.js";

// The module's state is process-wide — one agent, one informer — so every test
// starts from a clean one.
beforeEach(() => {
    resetHealthState();
    vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** Brings the informer up the way `watch.ts` does on a successful start. */
function informerStartSucceeds(): boolean {
    const attempt = beginInformerStart();
    return markInformerUp(attempt);
}

/**
 * A start attempt during which the informer emits 'error' — which is what a
 * failed initial list looks like, since `start()` resolves anyway.
 */
function informerStartFails(): boolean {
    const attempt = beginInformerStart();
    markInformerDown();
    return markInformerUp(attempt);
}

describe("liveness", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // Binding before the informer starts is only useful if the endpoint says
    // "alive" while the first sync is still running.
    it("is alive before the informer has ever started", () => {
        expect(checkLiveness().ok).toBe(true);
    });

    it("is alive while a running informer sees no events at all", () => {
        informerStartSucceeds();
        vi.advanceTimersByTime(60 * 60 * 1000);
        // A cluster whose workloads have not changed for an hour is healthy,
        // and event recency is deliberately not a liveness input.
        expect(checkLiveness().ok).toBe(true);
        expect(healthSnapshot().lastInformerEventAt).toBeNull();
    });

    it("tolerates an informer that is down for less than the grace window", () => {
        informerStartSucceeds();
        markInformerDown();
        vi.advanceTimersByTime(INFORMER_DOWN_GRACE_MS - 1);
        expect(checkLiveness().ok).toBe(true);
    });

    it("fails once the informer has been down for the grace window", () => {
        informerStartSucceeds();
        markInformerDown();
        vi.advanceTimersByTime(INFORMER_DOWN_GRACE_MS);
        const result = checkLiveness();
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/informer has not been watching/);
    });

    it("recovers when the informer starts again", () => {
        informerStartSucceeds();
        markInformerDown();
        vi.advanceTimersByTime(INFORMER_DOWN_GRACE_MS);
        expect(checkLiveness().ok).toBe(false);

        expect(informerStartSucceeds()).toBe(true);
        expect(checkLiveness().ok).toBe(true);
        expect(healthSnapshot().informerDownSince).toBeNull();
    });

    // The bug this whole module exists for: a restart that fails is reported
    // through 'error', not by rejecting, so a naive "start() resolved, we must
    // be up" would clear the clock every five seconds and the probe could
    // never fire.
    it("keeps the clock running across restarts that fail", () => {
        informerStartSucceeds();
        markInformerDown();

        for (let elapsed = 0; elapsed < INFORMER_DOWN_GRACE_MS; elapsed += 5000) {
            vi.advanceTimersByTime(5000);
            expect(informerStartFails()).toBe(false);
        }

        const result = checkLiveness();
        expect(result.ok).toBe(false);
        expect(healthSnapshot().informerRunning).toBe(false);
    });

    it("measures one continuous outage rather than the last error", () => {
        informerStartSucceeds();
        const downAt = Date.now();
        markInformerDown();
        vi.advanceTimersByTime(INFORMER_DOWN_GRACE_MS - 1);
        markInformerDown();
        expect(healthSnapshot().informerDownSince).toBe(downAt);
        vi.advanceTimersByTime(1);
        expect(checkLiveness().ok).toBe(false);
    });

    it("fails after enough consecutive heartbeat failures", () => {
        informerStartSucceeds();
        for (let i = 1; i < MAX_CONSECUTIVE_HEARTBEAT_FAILURES; i++) {
            recordHeartbeatFailure();
            expect(checkLiveness().ok).toBe(true);
        }
        recordHeartbeatFailure();
        const result = checkLiveness();
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/consecutive heartbeat failures/);
    });

    it("forgets heartbeat failures after one succeeds", () => {
        for (let i = 0; i < MAX_CONSECUTIVE_HEARTBEAT_FAILURES; i++) recordHeartbeatFailure();
        expect(checkLiveness().ok).toBe(false);

        recordHeartbeatOk();
        expect(checkLiveness().ok).toBe(true);
        expect(healthSnapshot().consecutiveHeartbeatFailures).toBe(0);
        expect(healthSnapshot().lastHeartbeatOkAt).toBe(Date.now());
    });
});

describe("readiness", () => {
    it("is not ready until the first sync completes", () => {
        const result = checkReadiness();
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/initial informer sync/);
    });

    it("is not ready when the first start attempt errored", () => {
        expect(informerStartFails()).toBe(false);
        expect(checkReadiness().ok).toBe(false);
    });

    it("is ready once the informer has synced", () => {
        informerStartSucceeds();
        expect(checkReadiness().ok).toBe(true);
    });

    // Readiness answers "has this process ever synced", not "is it watching
    // right now" — that is liveness' job, and there is no Service to remove
    // the pod from anyway.
    it("stays ready when a synced informer goes down", () => {
        informerStartSucceeds();
        markInformerDown();
        expect(checkReadiness().ok).toBe(true);
    });
});

describe("health server", () => {
    let server: Awaited<ReturnType<typeof startHealthServer>>;
    let base: string;

    beforeEach(async () => {
        // Port 0: the OS picks a free one, so the suite never collides with
        // whatever else is listening on the developer's machine.
        server = await startHealthServer(0);
        const { port } = server.address() as AddressInfo;
        base = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("serves 200 on /healthz while the agent is healthy", async () => {
        informerStartSucceeds();
        const res = await fetch(`${base}/healthz`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("ok");
        expect(body.informerRunning).toBe(true);
    });

    it("serves 503 with a reason when liveness fails", async () => {
        for (let i = 0; i < MAX_CONSECUTIVE_HEARTBEAT_FAILURES; i++) recordHeartbeatFailure();
        const res = await fetch(`${base}/healthz`);
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.status).toBe("unhealthy");
        expect(body.reason).toMatch(/heartbeat/);
        expect(body.consecutiveHeartbeatFailures).toBe(MAX_CONSECUTIVE_HEARTBEAT_FAILURES);
    });

    it("serves 503 on /readyz until the first sync, then 200", async () => {
        expect((await fetch(`${base}/readyz`)).status).toBe(503);
        informerStartSucceeds();
        expect((await fetch(`${base}/readyz`)).status).toBe(200);
    });

    it("ignores a query string", async () => {
        informerStartSucceeds();
        expect((await fetch(`${base}/healthz?probe=kubelet`)).status).toBe(200);
    });

    it("reports the last event it saw", async () => {
        informerStartSucceeds();
        recordInformerEvent();
        const body = await (await fetch(`${base}/healthz`)).json();
        expect(Date.parse(body.lastInformerEventAt)).toBeGreaterThan(0);
    });

    it("404s anything else", async () => {
        const res = await fetch(`${base}/`);
        expect(res.status).toBe(404);
    });

    it("refuses to bind a port that is not a port", async () => {
        await expect(startHealthServer(NaN)).rejects.toThrow(/port number/);
        await expect(startHealthServer(70000)).rejects.toThrow(/port number/);
        await expect(startHealthServer(-1)).rejects.toThrow(/port number/);
    });
});
