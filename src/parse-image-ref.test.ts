import { describe, it, expect } from "vitest";
import { isBareImageId, parseImageRef } from "./parse-image-ref.js";

describe("parseImageRef", () => {
    describe("project name extraction", () => {
        it("should return bare name when no registry or tag", () => {
            expect(parseImageRef("nginx").projectName).toBe("nginx");
        });

        it("should strip tag from name", () => {
            expect(parseImageRef("nginx:1.25").projectName).toBe("nginx");
        });

        it("should strip docker.io registry hostname", () => {
            expect(parseImageRef("docker.io/library/nginx:1.25").projectName).toBe("library/nginx");
        });

        it("should strip custom registry hostname with dot", () => {
            expect(parseImageRef("myregistry.io/team/myapp:v2.3.1").projectName).toBe("team/myapp");
        });

        it("should strip localhost registry", () => {
            expect(parseImageRef("localhost/myapp:dev").projectName).toBe("myapp");
        });

        it("should strip localhost with port", () => {
            expect(parseImageRef("localhost:5000/myapp:dev").projectName).toBe("myapp");
        });

        it("should NOT strip path component without dot or colon as registry", () => {
            // 'myteam/myapp' — 'myteam' has no dot/colon so not treated as registry
            expect(parseImageRef("myteam/myapp:v1").projectName).toBe("myteam/myapp");
        });

        it("should strip digest before parsing", () => {
            expect(parseImageRef("nginx@sha256:abc123").projectName).toBe("nginx");
        });

        it("should handle digest on a registry-prefixed image", () => {
            expect(parseImageRef("docker.io/library/nginx@sha256:abc123").projectName).toBe("library/nginx");
        });

        it("should strip both tag and digest", () => {
            expect(parseImageRef("ghcr.io/acme/api:v1.4.0@sha256:abc123").projectName).toBe("acme/api");
        });
    });

    // The scanner never invents a tag. "latest" for a tagless ref is the
    // registry's own default, and applying it here labelled every distinct
    // digest-pinned image identically.
    describe("tag extraction", () => {
        it("should return undefined when no tag present", () => {
            expect(parseImageRef("nginx").tag).toBeUndefined();
        });

        it("should extract plain version tag", () => {
            expect(parseImageRef("nginx:1.25").tag).toBe("1.25");
        });

        it("should extract semver tag with prefix", () => {
            expect(parseImageRef("myapp:v2.3.1").tag).toBe("v2.3.1");
        });

        it("should extract tag from image with registry", () => {
            expect(parseImageRef("docker.io/library/nginx:1.25").tag).toBe("1.25");
        });

        it("should return undefined when only digest present (no tag)", () => {
            expect(parseImageRef("nginx@sha256:abc123").tag).toBeUndefined();
        });

        it("should return undefined for a digest-pinned registry image", () => {
            expect(parseImageRef("ghcr.io/acme/api@sha256:abc123").tag).toBeUndefined();
        });

        it("should extract the tag when both tag and digest are present", () => {
            expect(parseImageRef("ghcr.io/acme/api:v1.4.0@sha256:abc123").tag).toBe("v1.4.0");
        });

        it("should not confuse registry port with tag", () => {
            expect(parseImageRef("localhost:5000/myapp:dev").tag).toBe("dev");
        });

        it("should return undefined for a tagless image behind a ported registry", () => {
            expect(parseImageRef("localhost:5000/myapp").tag).toBeUndefined();
        });
    });

    describe("registry extraction", () => {
        it("should return undefined when no registry prefix", () => {
            expect(parseImageRef("nginx:1.25").registry).toBeUndefined();
        });

        it("should extract docker.io registry", () => {
            expect(parseImageRef("docker.io/library/nginx:1.25").registry).toBe("docker.io");
        });

        it("should extract gcr.io registry", () => {
            expect(parseImageRef("gcr.io/myproject/myapp:v1").registry).toBe("gcr.io");
        });

        it("should extract custom registry with subdomain", () => {
            expect(parseImageRef("myregistry.io/team/myapp:v2.3.1").registry).toBe("myregistry.io");
        });

        it("should extract localhost as registry", () => {
            expect(parseImageRef("localhost/myapp:dev").registry).toBe("localhost");
        });

        it("should extract localhost:port as registry", () => {
            expect(parseImageRef("localhost:5000/myapp:dev").registry).toBe("localhost:5000");
        });

        it("should return undefined for path without registry hostname", () => {
            expect(parseImageRef("myteam/myapp:v1").registry).toBeUndefined();
        });
    });

    // containerd reports `containerStatus.image` as a bare image ID
    // (`sha256:` + 64 hex — the config hash, not even the registry digest)
    // when a digest-pinned pod gives it no tag. Splitting that on the colon
    // is what put 64-character "tags" in the workloads table.
    describe("bare image IDs", () => {
        const hex = "a4a8af0db08902e65347157c5efef6d1f9e261f03c8aa14b1b40bc182b947fe7";

        it("should parse a bare image ID to nothing", () => {
            expect(parseImageRef(`sha256:${hex}`)).toEqual({
                projectName: "",
                tag: undefined,
                registry: undefined,
            });
        });

        it("should parse a bare image ID with an appended digest to nothing", () => {
            expect(parseImageRef(`sha256:${hex}@sha256:${hex}`)).toEqual({
                projectName: "",
                tag: undefined,
                registry: undefined,
            });
        });

        it("should not treat a short sha256-prefixed ref as a bare ID", () => {
            // A repository actually named `sha256` with a tag stays a ref.
            expect(parseImageRef("sha256:v1").tag).toBe("v1");
        });

        it("isBareImageId matches only the full 64-hex form", () => {
            expect(isBareImageId(`sha256:${hex}`)).toBe(true);
            expect(isBareImageId("sha256:abc123")).toBe(false);
            expect(isBareImageId(`nginx@sha256:${hex}`)).toBe(false);
        });
    });
});
