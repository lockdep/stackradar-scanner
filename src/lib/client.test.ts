import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Read at module load by scan.ts; imports are hoisted, so this must be too.
vi.hoisted(() => {
    process.env.STACKRADAR_API_URL = "https://api.test";
    process.env.STACKRADAR_API_KEY = "test-key";
});

import {
    checkExistingSbom,
    heartbeat,
    HeartbeatRejectedError,
    isOlderVersion,
    lastHeartbeat,
    retryAfterMs,
    uploadSBOM,
    UploadRejectedError,
} from "./client.js";
import { resetHealthState } from "./health.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The agent's side of the backpressure and fleet-management contract. These
 * are the behaviours a rate-limited or mid-deploy control plane depends on:
 * a 429 is waited out, not treated as "not scanned"; a 5xx at startup is not
 * fatal; a 401 is; and the heartbeat's optional fields reach the log.
 */

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function stubFetch(replies: Reply[]) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
        calls.push(String(url));
        const reply = replies.shift() ?? { status: 200, body: { ok: true } };
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status: reply.status,
            headers: reply.headers,
        });
    });
    return calls;
}

beforeEach(() => {
    resetHealthState();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("retryAfterMs", () => {
    const res = (headers?: Record<string, string>) => new Response(null, { status: 429, headers });

    it("reads delay-seconds", () => {
        expect(retryAfterMs(res({ "retry-after": "7" }))).toBe(7000);
    });

    it("reads an HTTP date relative to now", () => {
        const now = Date.parse("2026-01-01T00:00:00Z");
        expect(retryAfterMs(res({ "retry-after": "Thu, 01 Jan 2026 00:00:10 GMT" }), now)).toBe(10_000);
    });

    it("defaults when the header is missing or unparseable", () => {
        expect(retryAfterMs(res())).toBe(5000);
        expect(retryAfterMs(res({ "retry-after": "soon" }))).toBe(5000);
    });

    it("refuses to block past the cap", () => {
        expect(retryAfterMs(res({ "retry-after": "3600" }))).toBeUndefined();
    });
});

describe("isOlderVersion", () => {
    it("orders dotted versions numerically", () => {
        expect(isOlderVersion("0.1.9", "0.1.10")).toBe(true);
        expect(isOlderVersion("0.1.10", "0.1.10")).toBe(false);
        expect(isOlderVersion("v1.0.0", "0.9.9")).toBe(false);
    });

    it("never tells an unparseable build to upgrade", () => {
        expect(isOlderVersion("unknown", "1.0.0")).toBe(false);
        expect(isOlderVersion("0.0.0-dev", "1.0.0")).toBe(true);
    });
});

describe("checkExistingSbom", () => {
    it("answers exists / missing from the body", async () => {
        stubFetch([{ status: 200, body: { exists: true } }, { status: 200, body: { exists: false } }]);
        expect(await checkExistingSbom("sha256:a")).toBe("exists");
        expect(await checkExistingSbom("sha256:a")).toBe("missing");
    });

    it("honours Retry-After on a 429 and then uses the real answer", async () => {
        const calls = stubFetch([
            { status: 429, headers: { "retry-after": "1" } },
            { status: 200, body: { exists: true } },
        ]);
        const pending = checkExistingSbom("sha256:a");
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toBe("exists");
        expect(calls).toHaveLength(2);
    });

    it("is unknown, not missing, when the server is still rate-limiting or down", async () => {
        stubFetch([{ status: 429 }, { status: 429 }, { status: 429 }]);
        const pending = checkExistingSbom("sha256:a");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toBe("unknown");

        stubFetch([{ status: 502 }]);
        expect(await checkExistingSbom("sha256:a")).toBe("unknown");

        vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
        expect(await checkExistingSbom("sha256:a")).toBe("unknown");
    });

    it("scans anyway on a 4xx about the request itself", async () => {
        stubFetch([{ status: 400 }]);
        expect(await checkExistingSbom("sha256:a")).toBe("missing");
    });
});

describe("heartbeat", () => {
    it("surfaces minScannerVersion and message from the response", async () => {
        stubFetch([{ status: 200, body: { ok: true, minScannerVersion: "9.9.9", message: "upgrade soon" } }]);
        const body = await heartbeat();
        expect(body.minScannerVersion).toBe("9.9.9");
        expect(lastHeartbeat()?.message).toBe("upgrade soon");
    });

    it("tells an auth failure from a deploy in progress", async () => {
        stubFetch([{ status: 401 }]);
        await expect(heartbeat()).rejects.toSatisfy(
            (e: unknown) => e instanceof HeartbeatRejectedError && e.isAuthFailure,
        );
        stubFetch([{ status: 502 }]);
        await expect(heartbeat()).rejects.toSatisfy(
            (e: unknown) => e instanceof HeartbeatRejectedError && !e.isAuthFailure,
        );
    });
});

describe("uploadSBOM", () => {
    const file = path.join(os.tmpdir(), `client-test-${process.pid}.json`);
    beforeEach(() => fs.writeFileSync(file, "{}"));
    afterEach(() => fs.rmSync(file, { force: true }));

    const upload = () => uploadSBOM(
        file,
        { imageDigest: "sha256:a", imageRef: "x", registry: undefined, repository: undefined },
        { namespace: "n", workloadName: "w", workloadKind: null, containerName: "c", imageTag: undefined },
    );

    it("marks a 400 permanent and a 503 retryable", async () => {
        stubFetch([{ status: 400, body: "bad" }]);
        await expect(upload()).rejects.toSatisfy((e: unknown) => e instanceof UploadRejectedError && !e.retryable);
        stubFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
        const pending = upload().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(20_000);
        const err = await pending;
        expect(err).toSatisfy((e: unknown) => e instanceof UploadRejectedError && e.retryable);
    });
});
