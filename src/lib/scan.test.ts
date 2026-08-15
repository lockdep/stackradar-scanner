import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { log } from "./logger.js";
import {
    RELEVANT_POD_LABEL_KEYS,
    RELEVANT_POD_ANNOTATION_KEYS,
    pickPodLabels,
    pickPodAnnotations,
    deriveWorkloadName,
    shouldScan,
    stripTagAndDigest,
    resolveRegistryAuth,
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
            "chart",
            "helm.sh/chart",
            "heritage",
            "release",
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

describe("stripTagAndDigest", () => {
    const cases: Array<[ref: string, expected: string]> = [
        ["registry.k8s.io/pause:3.9", "registry.k8s.io/pause"],
        ["registry.k8s.io/pause", "registry.k8s.io/pause"],
        [
            "ghcr.io/acme/api@sha256:" + "a".repeat(64),
            "ghcr.io/acme/api",
        ],
        // Both at once — the form a pod status usually carries.
        [
            "ghcr.io/acme/api:1.4.2@sha256:" + "a".repeat(64),
            "ghcr.io/acme/api",
        ],
        // A registry with a port. The colon is not a tag separator here, and
        // truncating at it would leave a pattern matching the host alone.
        ["registry.internal:5000/acme/api:1.4.2", "registry.internal:5000/acme/api"],
        ["registry.internal:5000/acme/api", "registry.internal:5000/acme/api"],
        // No registry at all: docker.io is implied but never written out, and
        // nothing here invents it.
        ["nginx:1.27", "nginx"],
        ["nginx", "nginx"],
    ];

    for (const [ref, expected] of cases) {
        it(`${ref} -> ${expected}`, () => {
            expect(stripTagAndDigest(ref)).toBe(expected);
        });
    }
});

describe("shouldScanImage", () => {
    // Patterns are compiled once at module load, so each case needs a fresh
    // module instance — and a fresh logger with it, since resetModules gives
    // the reloaded scan.js its own copy of logger.js that a spy on this file's
    // import would never see.
    const load = async (excludeImages?: string) => {
        vi.resetModules();
        const warn = vi.fn();
        vi.doMock("./logger.js", () => ({
            log: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() },
        }));
        if (excludeImages === undefined) delete process.env.EXCLUDE_IMAGES;
        else process.env.EXCLUDE_IMAGES = excludeImages;

        const mod = await import("./scan.js");
        return { shouldScanImage: mod.shouldScanImage, patterns: mod.EXCLUDE_IMAGES, warn };
    };

    const savedEnv = { ...process.env };
    afterEach(() => {
        vi.doUnmock("./logger.js");
        vi.resetModules();
        process.env = { ...savedEnv };
    });

    // The default. An install that sets nothing must behave exactly as it did
    // before this value existed.
    it("scans everything when no patterns are set", async () => {
        const { shouldScanImage, patterns } = await load(undefined);
        expect(patterns).toEqual([]);
        expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(true);
        expect(shouldScanImage("ghcr.io/acme/api:1.4.2")).toBe(true);
        expect(shouldScanImage("")).toBe(true);
    });

    it("treats an empty and a whitespace-only list as unset", async () => {
        for (const value of ["", " , "]) {
            const { shouldScanImage, patterns } = await load(value);
            expect(patterns).toEqual([]);
            expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(true);
        }
    });

    describe("a registry prefix", () => {
        it("skips images under it, at any depth", async () => {
            const { shouldScanImage } = await load("registry.k8s.io/*");
            expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(false);
            expect(shouldScanImage("registry.k8s.io/kube-proxy:v1.31.0")).toBe(false);
            expect(shouldScanImage("registry.k8s.io/sig-storage/csi-provisioner:v4.0.0")).toBe(false);
        });

        // Anchored at both ends, which is the whole reason a mirror is safe:
        // the host has to *be* registry.k8s.io, not merely contain it.
        it("does not skip a registry that only contains the pattern", async () => {
            const { shouldScanImage } = await load("registry.k8s.io/*");
            expect(shouldScanImage("myregistry.io/registry.k8s.io-mirror/app:1.0")).toBe(true);
            expect(shouldScanImage("registry.k8s.io.evil.example/pause:3.9")).toBe(true);
        });
    });

    it("matches a trailing name regardless of registry host", async () => {
        const { shouldScanImage } = await load("*/pause");
        expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(false);
        expect(shouldScanImage("k8s.gcr.io/pause:3.5")).toBe(false);
        expect(shouldScanImage("mcr.microsoft.com/oss/kubernetes/pause:3.6")).toBe(false);
        expect(shouldScanImage("registry.k8s.io/pause-something:3.9")).toBe(true);
    });

    // The point of stripping: a pattern written once keeps working as the tag
    // moves and as the digest changes underneath it.
    it("matches against the tag- and digest-stripped name", async () => {
        const { shouldScanImage } = await load("ghcr.io/acme/vendor-*");
        const digest = "@sha256:" + "b".repeat(64);
        expect(shouldScanImage("ghcr.io/acme/vendor-agent")).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/vendor-agent:2.1.0")).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/vendor-agent" + digest)).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/vendor-agent:2.1.0" + digest)).toBe(false);
    });

    it("takes several patterns, trimming whitespace around them", async () => {
        const { shouldScanImage, patterns } = await load(
            " registry.k8s.io/* , */pause , ghcr.io/acme/vendor-* "
        );
        expect(patterns).toEqual(["registry.k8s.io/*", "*/pause", "ghcr.io/acme/vendor-*"]);
        expect(shouldScanImage("registry.k8s.io/kube-proxy:v1.31.0")).toBe(false);
        expect(shouldScanImage("docker.io/library/pause:3.9")).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/vendor-agent:2.1.0")).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/payments-api:1.4.2")).toBe(true);
    });

    // Regex metacharacters are literal. A dot in a hostname is a dot, so a
    // pattern is never quietly broader than it reads.
    it("treats everything but * as a literal", async () => {
        const { shouldScanImage } = await load("ghcr.io/acme/api");
        expect(shouldScanImage("ghcr.io/acme/api:1.4.2")).toBe(false);
        expect(shouldScanImage("ghcrxio/acme/api:1.4.2")).toBe(true);
        expect(shouldScanImage("ghcr.io/acme/apis:1.4.2")).toBe(true);
    });

    it("keeps a registry port in the pattern working", async () => {
        const { shouldScanImage, patterns } = await load("registry.internal:5000/*");
        expect(patterns).toEqual(["registry.internal:5000/*"]);
        expect(shouldScanImage("registry.internal:5000/acme/api:1.4.2")).toBe(false);
        expect(shouldScanImage("ghcr.io/acme/api:1.4.2")).toBe(true);
    });

    // A pattern carrying a tag can never match, because matching happens
    // against the stripped name. Dropping it errs towards scanning: the cost
    // is one scan that was meant to be skipped, not coverage lost — and the
    // warning is how someone finds out their pattern is doing nothing.
    describe("a pattern that cannot match", () => {
        it("is dropped, with a warning naming it, and the agent keeps running", async () => {
            const { shouldScanImage, patterns, warn } = await load("registry.k8s.io/pause:3.9");
            expect(patterns).toEqual([]);
            expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(true);
            expect(warn).toHaveBeenCalledTimes(1);
            const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
            expect(fields).toMatchObject({ pattern: "registry.k8s.io/pause:3.9" });
        });

        it("is dropped when it carries a digest", async () => {
            const { patterns, warn } = await load("ghcr.io/acme/api@sha256:" + "c".repeat(64));
            expect(patterns).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
        });

        // The one that matters most: a bad pattern must not take the good ones
        // down with it, or a typo turns off exclusion the operator still wants.
        it("does not stop the patterns beside it from working", async () => {
            const { shouldScanImage, patterns, warn } = await load(
                "registry.k8s.io/pause:3.9,*/pause"
            );
            expect(patterns).toEqual(["*/pause"]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(shouldScanImage("registry.k8s.io/pause:3.9")).toBe(false);
            expect(shouldScanImage("ghcr.io/acme/api:1.4.2")).toBe(true);
        });
    });
});

// The 403 path exists because `scanner.imagePullSecretNames` narrows the
// ClusterRole to named Secrets: a workload referencing one that was left off
// the list gets a denial rather than a Secret. That has to cost the image its
// credentials and nothing more — an exception here would abort a scan over a
// deliberate RBAC setting.
describe("resolveRegistryAuth", () => {
    const dockerConfig = (registry: string, user: string, pass: string) => ({
        data: {
            ".dockerconfigjson": Buffer.from(
                JSON.stringify({
                    auths: { [registry]: { auth: Buffer.from(`${user}:${pass}`).toString("base64") } },
                })
            ).toString("base64"),
        },
    });

    // A fake CoreV1Api that serves the named secrets and denies everything
    // else the way the API server does when resourceNames excludes a name.
    const coreApiWith = (secrets: Record<string, unknown>) =>
        ({
            readNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
                const secret = secrets[name];
                if (!secret) throw new k8s.ApiException(403, "Forbidden", {}, {});
                return secret;
            }),
        }) as unknown as k8s.CoreV1Api;

    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
    });

    it("decodes the credentials in a dockerconfigjson Secret", async () => {
        const auths = await resolveRegistryAuth(
            coreApiWith({ regcred: dockerConfig("ghcr.io", "bot", "hunter2") }),
            "payments",
            ["regcred"]
        );
        expect(auths).toEqual({ "ghcr.io": { username: "bot", password: "hunter2" } });
        expect(warn).not.toHaveBeenCalled();
    });

    it("keeps going past a denied Secret and still returns the ones it could read", async () => {
        const auths = await resolveRegistryAuth(
            coreApiWith({ allowed: dockerConfig("ghcr.io", "bot", "hunter2") }),
            "payments",
            ["denied", "allowed"]
        );
        expect(auths).toEqual({ "ghcr.io": { username: "bot", password: "hunter2" } });
    });

    // The log line is the whole UX of the allowlist: someone who forgets a
    // Secret finds out which one from this, or not at all.
    it("names the denied Secret, its namespace and the value to fix", async () => {
        await resolveRegistryAuth(coreApiWith({}), "payments", ["regcred"]);

        expect(warn).toHaveBeenCalledTimes(1);
        const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
        expect(fields).toMatchObject({ secret: "regcred", namespace: "payments", status: 403 });
        expect(message).toContain("scanner.imagePullSecretNames");
    });

    // Nothing about a pod referencing a Secret that does not exist is an
    // allowlist problem, so that advice must not be attached to it.
    it("does not blame the allowlist for a failure that is not a denial", async () => {
        const coreApi = {
            readNamespacedSecret: vi.fn(async () => {
                throw new k8s.ApiException(404, "Not Found", {}, {});
            }),
        } as unknown as k8s.CoreV1Api;

        await expect(resolveRegistryAuth(coreApi, "payments", ["regcred"])).resolves.toEqual({});
        const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
        expect(fields).toMatchObject({ secret: "regcred", status: 404 });
        expect(message).not.toContain("scanner.imagePullSecretNames");
    });
});
