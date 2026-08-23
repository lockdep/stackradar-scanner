import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { log } from "./logger.js";
import { configureProxy, redactProxyCredentials } from "./proxy.js";

// `configureProxy` mutates process-wide state — the environment it reads and
// undici's global dispatcher — so every test restores both. Leaving a
// ProxyAgent installed would silently divert any later test that fetches.
const PROXY_VARS = [
    "HTTP_PROXY", "http_proxy",
    "HTTPS_PROXY", "https_proxy",
    "NO_PROXY", "no_proxy",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
    savedEnv = Object.fromEntries(PROXY_VARS.map((v) => [v, process.env[v]]));
    for (const v of PROXY_VARS) delete process.env[v];
    savedDispatcher = getGlobalDispatcher();
});

afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    setGlobalDispatcher(savedDispatcher);
    vi.restoreAllMocks();
});

describe("configureProxy", () => {
    it("leaves the dispatcher alone when no proxy is configured", () => {
        const before = getGlobalDispatcher();
        configureProxy();
        expect(getGlobalDispatcher()).toBe(before);
    });

    // A pod spec carrying `HTTPS_PROXY=""` must not read as "proxying is
    // disabled" — that would take the agent offline in exactly the clusters
    // this feature exists for.
    it("treats blank and whitespace-only values as unset", () => {
        process.env.HTTPS_PROXY = "";
        process.env.https_proxy = "   ";
        const before = getGlobalDispatcher();
        configureProxy();
        expect(getGlobalDispatcher()).toBe(before);
    });

    it("installs an env-reading dispatcher when a proxy is configured", () => {
        process.env.HTTPS_PROXY = "http://proxy.corp:8080";
        configureProxy();
        expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    });

    it("falls through to HTTP_PROXY when only that is set", () => {
        process.env.HTTP_PROXY = "http://proxy.corp:8080";
        configureProxy();
        expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    });

    // The startup line is where an operator confirms the proxy took effect, so
    // it has to name the proxy — and must never name the password.
    it("logs the proxy with its credentials redacted", () => {
        const info = vi.spyOn(log, "info").mockImplementation(() => {});
        process.env.HTTPS_PROXY = "http://svc-account:hunter2@proxy.corp:8080";
        process.env.NO_PROXY = "registry.internal";

        configureProxy();

        expect(info).toHaveBeenCalledTimes(1);
        const [fields] = info.mock.calls[0] as [{ proxy: string; noProxy?: string }];
        expect(fields.proxy).not.toContain("hunter2");
        expect(fields.proxy).toContain("proxy.corp:8080");
        expect(fields.noProxy).toBe("registry.internal");
    });
});

describe("redactProxyCredentials", () => {
    it("leaves a credential-free URL untouched", () => {
        expect(redactProxyCredentials("http://proxy.corp:8080"))
            .toBe("http://proxy.corp:8080");
    });

    it("redacts a user and password", () => {
        expect(redactProxyCredentials("http://svc-account:hunter2@proxy.corp:8080"))
            .toBe("http://***@proxy.corp:8080");
    });

    it("redacts a username with no password", () => {
        expect(redactProxyCredentials("https://svc-account@proxy.corp:3128"))
            .toBe("https://***@proxy.corp:3128");
    });

    // `new URL` reads this as scheme `svc-account:` and reports no username, so
    // a redaction built on the parser would return the password verbatim.
    it("redacts a scheme-less URL that the URL parser mis-reads", () => {
        expect(redactProxyCredentials("svc-account:hunter2@proxy.corp:8080"))
            .toBe("***@proxy.corp:8080");
    });

    it("redacts back to the last @ when the password contains one", () => {
        expect(redactProxyCredentials("http://user:p@ss@proxy.corp:8080"))
            .toBe("http://***@proxy.corp:8080");
    });

    // An `@` past the authority is part of the path, not a credential.
    it("leaves an @ in the path alone", () => {
        expect(redactProxyCredentials("http://proxy.corp:8080/a@b"))
            .toBe("http://proxy.corp:8080/a@b");
    });
});
