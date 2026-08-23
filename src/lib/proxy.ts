import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { log } from "./logger.js";

// ─── Egress proxy ────────────────────────────────────────────────────────────

/**
 * Routes the agent's outbound HTTP through the proxy named in the environment.
 *
 * Node's built-in `fetch` is undici, and undici deliberately ignores
 * `HTTP_PROXY` / `HTTPS_PROXY` — the env vars every other tool in the image
 * honours. So in a cluster with no direct egress, setting the conventional
 * variables silently fixes syft (a Go binary) and leaves every call in
 * `client.ts` failing with `fetch failed`. Installing a dispatcher is the only
 * way to close that gap.
 *
 * `EnvHttpProxyAgent` reads the variables itself, including the `NO_PROXY`
 * bypass list with its suffix and CIDR matching — the part a hand-rolled
 * `ProxyAgent` gets wrong.
 *
 * Two things are deliberately *not* routed through it:
 *
 * - **The Kubernetes API.** `@kubernetes/client-node` builds its requests on
 *   `node-fetch`, not undici, so it never sees this dispatcher. That is the
 *   behaviour we want — the API server is in-cluster — and the chart also
 *   names it in `NO_PROXY` so the same holds for anything that does read the
 *   environment.
 * - **syft.** It inherits `process.env` from `generateSBOM`, honours the
 *   variables natively, and needs no help.
 */
export function configureProxy(): void {
    // HTTPS first: a proxy that is set up for both is reached over the HTTPS
    // variable, and the StackRadar API is https. Lower-case variants are read
    // too — tooling disagrees on which spelling is canonical, so a cluster
    // where only one is set should still work.
    const proxy = firstSet("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
    if (!proxy) return;

    setGlobalDispatcher(new EnvHttpProxyAgent());

    log.info(
        {
            proxy: redactProxyCredentials(proxy),
            noProxy: firstSet("NO_PROXY", "no_proxy"),
        },
        "routing outbound HTTP through proxy",
    );
}

/**
 * First of `names` set to something other than whitespace.
 *
 * An empty value means "not configured" rather than "the empty proxy": a
 * `HTTPS_PROXY=""` left in a pod spec should fall through to `HTTP_PROXY`, not
 * disable proxying and take the agent offline.
 */
function firstSet(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) return value;
    }
    return undefined;
}

/**
 * Replaces any userinfo in a proxy URL with `***`.
 *
 * Corporate proxy URLs routinely carry `user:pass@`, and this one is logged at
 * startup, where it lands in whatever ships the cluster's logs.
 *
 * This works on the raw string rather than on a parsed `URL`, because parsing
 * fails in exactly the case that matters: `new URL("user:pass@proxy.corp")`
 * does not throw and does not report a username — it reads `user:` as the
 * scheme — so a check for `url.username` hands the password straight back. The
 * authority is everything up to the first `/?#`, and everything before its last
 * `@` is userinfo by definition; a later `@` in a path is left alone.
 */
export function redactProxyCredentials(proxyUrl: string): string {
    const schemeEnd = proxyUrl.indexOf("://");
    const scheme = schemeEnd === -1 ? "" : proxyUrl.slice(0, schemeEnd + 3);
    const rest = proxyUrl.slice(scheme.length);

    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);

    const at = authority.lastIndexOf("@");
    if (at === -1) return proxyUrl;
    return `${scheme}***@${rest.slice(at + 1)}`;
}
