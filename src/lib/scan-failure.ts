/**
 * Classify why a syft run failed, for display only.
 *
 * The codes cross the wire on the inventory report and end up on the cluster's
 * coverage card, where `registry_auth` is the one that carries a remediation
 * ("configure pull secrets") and `registry_rate_limited` explicitly must not —
 * showing the credentials fix for a transient 429 would train users to ignore
 * the banner. Detection is therefore classification, not a boolean.
 *
 * Two constraints, both load-bearing (see
 * docs/contracts/inventory-v3.md, "Scan failures are display-only
 * classification" in the control-plane repo):
 *
 * - **Retry policy does not change.** A 401 can be an expired token, so every
 *   failure still retries on the cooldown regardless of its code. Nothing may
 *   branch on the result of {@link classifyScanFailure} except rendering.
 * - **Brittleness is contained.** Parsing stderr is fragile across syft
 *   versions, but the image pins its syft, so the patterns are validated per
 *   release — and anything unmatched degrades to `scan_error`, never to a
 *   misclassification.
 */

export const SCAN_FAILURE_CODES = [
    "registry_auth",
    "registry_rate_limited",
    "scan_error",
] as const;

export type ScanFailureCode = (typeof SCAN_FAILURE_CODES)[number];

/**
 * One failed scan, as reported on the inventory. Deliberately this narrow:
 * raw stderr carries full registry URLs and API response bodies, and this
 * lands in a shared UI — only the code and the registry host may leave the
 * agent.
 */
export interface ScanFailure {
    imageDigest: string;
    code: ScanFailureCode;
    /** Host only, e.g. `registry.digitalocean.com`. `null` when the ref never named one. */
    registryHost: string | null;
}

/*
 * Matched against the words the registry protocols actually use, not bare
 * status numbers: a naked `401` would false-positive inside a digest or a
 * temp-file timestamp, so the numeric forms are only read behind the
 * "status code" phrasing syft's transport prints them with.
 */
const AUTH_PATTERN = /\bunauthorized\b|\bdenied\b|\bforbidden\b|status code:? 40[13]\b/i;
const RATE_LIMIT_PATTERN = /\btoomanyrequests\b|too many requests|rate exceeded|status code:? 429\b/i;

/**
 * `registry_auth` before `registry_rate_limited`: on the rare stderr that says
 * both, credentials are the actionable half — and configured credentials
 * usually lift the anonymous rate limit as well.
 */
export function classifyScanFailure(stderr: string): ScanFailureCode {
    if (AUTH_PATTERN.test(stderr)) return "registry_auth";
    if (RATE_LIMIT_PATTERN.test(stderr)) return "registry_rate_limited";
    return "scan_error";
}
