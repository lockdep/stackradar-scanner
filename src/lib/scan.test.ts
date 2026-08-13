import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    RELEVANT_POD_LABEL_KEYS,
    RELEVANT_POD_ANNOTATION_KEYS,
    pickPodLabels,
    pickPodAnnotations,
    deriveWorkloadName,
    shouldScan,
} from "./scan.js";

// These tests guard the boundary README.md describes to customers: what pod
// metadata is allowed to leave their cluster. A widened filter or a refactor
// that forwards the raw label map would leak silently, so the assertions here
// are deliberately about what is *dropped* as much as what is kept.

describe("the label and annotation allowlists", () => {
    // Snapshots, not equality assertions: adding a key produces a diff a
    // reviewer has to accept on purpose, which is the whole point.
    it("keeps exactly these pod labels", () => {
        expect([...RELEVANT_POD_LABEL_KEYS].sort()).toMatchInlineSnapshot(`
          [
            "app",
            "app.kubernetes.io/component",
            "app.kubernetes.io/instance",
            "app.kubernetes.io/managed-by",
            "app.kubernetes.io/name",
            "app.kubernetes.io/part-of",
            "app.kubernetes.io/version",
            "helm.sh/chart",
            "version",
          ]
        `);
    });

    it("keeps exactly these pod annotations", () => {
        expect([...RELEVANT_POD_ANNOTATION_KEYS].sort()).toMatchInlineSnapshot(`
          [
            "argocd.argoproj.io/tracking-id",
            "meta.helm.sh/release-name",
            "meta.helm.sh/release-namespace",
          ]
        `);
    });
});

describe("pickPodLabels", () => {
    it("keeps every allowlisted key", () => {
        const input = Object.fromEntries(
            [...RELEVANT_POD_LABEL_KEYS].map((k) => [k, `value-of-${k}`])
        );
        expect(pickPodLabels(input)).toEqual(input);
    });

    it("drops labels that are not allowlisted", () => {
        expect(
            pickPodLabels({
                app: "api",
                "secret-name": "prod-db-credentials",
                "vault.hashicorp.com/role": "payments-prod",
                "customer.internal/cost-centre": "acme-holdings-emea",
                "pod-template-hash": "7d9f8b6c4",
            })
        ).toEqual({ app: "api" });
    });

    it("drops everything when nothing is allowlisted", () => {
        expect(pickPodLabels({ "secret-name": "prod-db-credentials" })).toEqual({});
    });

    it("returns an empty object for undefined labels", () => {
        expect(pickPodLabels(undefined)).toEqual({});
    });

    it("does not alias the caller's object", () => {
        const input = { app: "api" };
        const picked = pickPodLabels(input);
        picked.app = "mutated";
        expect(input.app).toBe("api");
    });
});

describe("pickPodAnnotations", () => {
    it("keeps every allowlisted key", () => {
        const input = Object.fromEntries(
            [...RELEVANT_POD_ANNOTATION_KEYS].map((k) => [k, `value-of-${k}`])
        );
        expect(pickPodAnnotations(input)).toEqual(input);
    });

    it("drops annotations that are not allowlisted", () => {
        expect(
            pickPodAnnotations({
                "meta.helm.sh/release-name": "payments",
                // The classic leak: kubectl stores the entire applied manifest,
                // env vars and all, in this annotation.
                "kubectl.kubernetes.io/last-applied-configuration": '{"spec":{"env":[...]}}',
                "vault.hashicorp.com/agent-inject-secret-db": "database/creds/prod",
                "checksum/secret": "9f2b1c...",
            })
        ).toEqual({ "meta.helm.sh/release-name": "payments" });
    });

    it("returns an empty object for undefined annotations", () => {
        expect(pickPodAnnotations(undefined)).toEqual({});
    });
});

describe("deriveWorkloadName", () => {
    it("prefers app.kubernetes.io/name over app", () => {
        expect(
            deriveWorkloadName("payments-7d9f8b6c4-x2k9p", {
                "app.kubernetes.io/name": "payments-api",
                app: "payments",
            })
        ).toBe("payments-api");
    });

    it("falls back to app when app.kubernetes.io/name is absent", () => {
        expect(deriveWorkloadName("payments-7d9f8b6c4-x2k9p", { app: "payments" })).toBe(
            "payments"
        );
    });

    it("ignores unrelated labels and strips the pod name instead", () => {
        expect(
            deriveWorkloadName("payments-7d9f8b6c4-x2k9p", { "pod-template-hash": "7d9f8b6c4" })
        ).toBe("payments");
    });

    // The suffix-stripping regex is the fallback for pods with no usable label.
    // It has to remove controller-generated suffixes without eating parts of a
    // real name, so the cases below pin both directions.
    describe("suffix stripping", () => {
        const cases: Array<[name: string, expected: string]> = [
            // Deployment: ReplicaSet hash plus pod suffix, both stripped.
            ["api-7d9f8b6c4-x2k9p", "api"],
            ["payments-api-5f6d7c8b9d-2xq4z", "payments-api"],
            // DaemonSet / bare ReplicaSet: a single generated suffix.
            ["fluentd-x2k9p", "fluentd"],
            // StatefulSet ordinals are too short to look generated, and must
            // survive — `postgres-0` and `postgres-1` are the same workload but
            // the ordinal is how you tell the replicas apart.
            ["postgres-0", "postgres-0"],
            ["postgres-10", "postgres-10"],
            // CronJob-created Job pods: the run timestamp and the pod suffix
            // both go, so every run rolls up under one name.
            ["backup-29605320-x2k9p", "backup"],
            // ...but only when the trailing segment contains a digit. The
            // all-letter suffix Kubernetes occasionally generates is left
            // alone, and that run reports under its own name. Pinned rather
            // than fixed: widening the regex risks eating real name segments,
            // and the workload name is a user-visible project key.
            ["backup-29605320-abcde", "backup-29605320-abcde"],
            // Nothing generated to strip.
            ["nginx", "nginx"],
            ["kube-apiserver", "kube-apiserver"],
            // A hyphenated segment with no digit is not a generated suffix.
            ["my-app-server", "my-app-server"],
            // Version-like segments do get stripped — a known cost of the
            // heuristic, pinned here so a change to it is visible.
            ["my-app-v1234", "my-app"],
        ];

        for (const [name, expected] of cases) {
            it(`${name} -> ${expected}`, () => {
                expect(deriveWorkloadName(name, undefined)).toBe(expected);
            });
        }

        it("never returns an empty string for a name that is all suffix", () => {
            expect(deriveWorkloadName("x2k9p", undefined)).toBe("x2k9p");
        });
    });
});

describe("shouldScan", () => {
    // The include/exclude sets are read from the environment at module load, so
    // each case needs a fresh module instance.
    const load = async (env: Record<string, string | undefined>) => {
        vi.resetModules();
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        return (await import("./scan.js")).shouldScan;
    };

    const savedEnv = { ...process.env };
    beforeEach(() => {
        delete process.env.INCLUDE_NAMESPACES;
        delete process.env.EXCLUDE_NAMESPACES;
    });
    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it("excludes the control-plane namespaces by default", () => {
        expect(shouldScan("kube-system")).toBe(false);
        expect(shouldScan("kube-public")).toBe(false);
        expect(shouldScan("kube-node-lease")).toBe(false);
        expect(shouldScan("default")).toBe(true);
    });

    it("honours a custom exclude list", async () => {
        const fn = await load({ EXCLUDE_NAMESPACES: "argocd, cert-manager" });
        expect(fn("argocd")).toBe(false);
        expect(fn("cert-manager")).toBe(false);
        // A custom list replaces the defaults rather than adding to them.
        expect(fn("kube-system")).toBe(true);
    });

    // Precedence: an include list is an allowlist, so it wins outright.
    it("scans only the include list when one is set, ignoring excludes", async () => {
        const fn = await load({
            INCLUDE_NAMESPACES: "payments,checkout",
            EXCLUDE_NAMESPACES: "payments",
        });
        expect(fn("payments")).toBe(true);
        expect(fn("checkout")).toBe(true);
        expect(fn("default")).toBe(false);
        expect(fn("kube-system")).toBe(false);
    });

    // The chart passes INCLUDE_NAMESPACES through only when non-empty, but an
    // empty string set by hand must not be read as "scan nothing".
    it("treats an empty include list as unset", async () => {
        const fn = await load({ INCLUDE_NAMESPACES: "" });
        expect(fn("default")).toBe(true);
        expect(fn("kube-system")).toBe(false);
    });

    // An allowlist that parses to nothing must not mean "scan nothing" — that
    // failure is invisible, since the agent stays up and reports no images.
    it("treats a whitespace-only include list as unset", async () => {
        const fn = await load({ INCLUDE_NAMESPACES: " , " });
        expect(fn("default")).toBe(true);
        expect(fn("kube-system")).toBe(false);
    });

    it("trims whitespace around names", async () => {
        const fn = await load({ INCLUDE_NAMESPACES: " payments , checkout " });
        expect(fn("payments")).toBe(true);
        expect(fn("checkout")).toBe(true);
    });
});
