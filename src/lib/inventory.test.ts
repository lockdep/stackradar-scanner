import { describe, it, expect } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { buildInventory, podImages } from "./scan.js";

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

function pod(options: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    phase?: string;
    containers?: { name: string; image: string; imageID?: string; running?: boolean }[];
}): k8s.V1Pod {
    const containers = options.containers ?? [{ name: "main", image: "ghcr.io/acme/api:v1", imageID: `ghcr.io/acme/api@${DIGEST_A}` }];
    return {
        metadata: { name: options.name, namespace: options.namespace ?? "default", labels: options.labels },
        spec: {},
        status: {
            phase: options.phase ?? "Running",
            containerStatuses: containers.map((c) => ({
                name: c.name,
                image: c.image,
                imageID: c.imageID ?? "",
                ready: true,
                restartCount: 0,
                state: c.running === false ? { waiting: {} } : { running: { startedAt: new Date() } },
            })),
        },
    } as k8s.V1Pod;
}

/**
 * The inventory report is what the Dashboard's "47 discovered, 6 scanned"
 * denominator is built from, so what matters here is that it counts the same
 * things the scan queue eventually uploads — one entry per workload container,
 * not per replica.
 */
describe("buildInventory", () => {
    it("collapses replicas of one workload into a single entry", () => {
        const pods = [
            pod({ name: "api-7d9f8b6c4d-abcde", labels: { app: "api" } }),
            pod({ name: "api-7d9f8b6c4d-fghij", labels: { app: "api" } }),
            pod({ name: "api-7d9f8b6c4d-klmno", labels: { app: "api" } }),
        ];

        const inventory = buildInventory(pods);

        expect(inventory).toHaveLength(1);
        expect(inventory[0]).toMatchObject({ namespace: "default", workloadName: "api", containerName: "main" });
    });

    it("counts each container of a multi-container pod separately", () => {
        const inventory = buildInventory([
            pod({
                name: "api-7d9f8b6c4d-abcde",
                labels: { app: "api" },
                containers: [
                    { name: "main", image: "ghcr.io/acme/api:v1", imageID: `ghcr.io/acme/api@${DIGEST_A}` },
                    { name: "sidecar", image: "ghcr.io/acme/proxy:v1", imageID: `ghcr.io/acme/proxy@${DIGEST_B}` },
                ],
            }),
        ]);

        expect(inventory.map((w) => w.containerName).sort()).toEqual(["main", "sidecar"]);
    });

    it("separates the same workload name in different namespaces", () => {
        const inventory = buildInventory([
            pod({ name: "api-7d9f8b6c4d-abcde", namespace: "prod", labels: { app: "api" } }),
            pod({ name: "api-7d9f8b6c4d-fghij", namespace: "staging", labels: { app: "api" } }),
        ]);

        expect(inventory.map((w) => w.namespace).sort()).toEqual(["prod", "staging"]);
    });

    it("reports the digest-pinned reference the scanner would pull", () => {
        const [entry] = buildInventory([pod({ name: "api-7d9f8b6c4d-abcde", labels: { app: "api" } })]);

        expect(entry!.imageRef).toBe(`ghcr.io/acme/api@${DIGEST_A}`);
        expect(entry!.imageDigest).toBe(DIGEST_A);
    });

    it("excludes namespaces the scanner is configured to skip", () => {
        // `kube-system` is in the default EXCLUDE_NAMESPACES set.
        const inventory = buildInventory([pod({ name: "coredns-abc", namespace: "kube-system", labels: { app: "coredns" } })]);

        expect(inventory).toEqual([]);
    });

    it("omits containers that have not started, since there is nothing to scan yet", () => {
        const inventory = buildInventory([
            pod({
                name: "api-7d9f8b6c4d-abcde",
                labels: { app: "api" },
                containers: [{ name: "main", image: "ghcr.io/acme/api:v1", imageID: "", running: false }],
            }),
        ]);

        expect(inventory).toEqual([]);
    });

    it("counts exactly what the scan queue would enqueue", () => {
        const pods = [
            pod({ name: "api-7d9f8b6c4d-abcde", labels: { app: "api" } }),
            pod({ name: "api-7d9f8b6c4d-fghij", labels: { app: "api" } }),
            pod({ name: "web-5c6d7e8f9a-klmno", labels: { app: "web" }, containers: [{ name: "main", image: "ghcr.io/acme/web:v1", imageID: `ghcr.io/acme/web@${DIGEST_B}` }] }),
        ];

        // Every entry the inventory reports is one the scanner would also try
        // to scan; a discovered count larger than that would never converge.
        const scannable = new Set(
            pods.flatMap(podImages).map((i) => `${i.namespace}/${i.workloadName}/${i.containerName}`),
        );
        const discovered = buildInventory(pods).map((w) => `${w.namespace}/${w.workloadName}/${w.containerName}`);

        expect(new Set(discovered)).toEqual(scannable);
    });
});
