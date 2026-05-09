import { describe, it, expect } from "vitest";
import { parseImageRef } from "./parse-image-ref.js";

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
    });

    describe("version extraction", () => {
        it("should return 'latest' when no tag present", () => {
            expect(parseImageRef("nginx").version).toBe("latest");
        });

        it("should extract plain version tag", () => {
            expect(parseImageRef("nginx:1.25").version).toBe("1.25");
        });

        it("should extract semver tag with prefix", () => {
            expect(parseImageRef("myapp:v2.3.1").version).toBe("v2.3.1");
        });

        it("should extract tag from image with registry", () => {
            expect(parseImageRef("docker.io/library/nginx:1.25").version).toBe("1.25");
        });

        it("should return 'latest' when only digest present (no tag)", () => {
            expect(parseImageRef("nginx@sha256:abc123").version).toBe("latest");
        });

        it("should not confuse registry port with tag", () => {
            expect(parseImageRef("localhost:5000/myapp:dev").version).toBe("dev");
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
});
