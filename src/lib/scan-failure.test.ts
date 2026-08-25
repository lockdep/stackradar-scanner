import { describe, it, expect } from "vitest";
import { classifyScanFailure } from "./scan-failure.js";

/*
 * The first two samples are verbatim from the 25 Aug 2026 dev-cluster log
 * (`watcher.log`) that motivated the feature — the DO registry 401 that
 * needed credentials, and the ECR anonymous rate limit that healed itself.
 * They are the acceptance criteria's fixtures, not illustrations: the
 * classifier exists to keep exactly these two apart.
 */

const DO_401 = `Command failed: syft registry:registry.digitalocean.com/stack-radar/stack-radar-client@sha256:4748f8e40d3810f885107805222a09eb07d81243cad04f9ebc00f6b79bbfde11 -o cyclonedx-json@1.6=/tmp/sbom-1787651509518-bssqprxeyji.json
[0000]  WARN unable to get filesystem cache at /.cache/syft: unable to create directory at '/.cache/syft': mkdir /.cache: read-only file system
[0000] ERROR could not determine source: errors occurred attempting to resolve 'registry.digitalocean.com/stack-radar/stack-radar-client@sha256:4748f8e40d3810f885107805222a09eb07d81243cad04f9ebc00f6b79bbfde11':
  - oci-registry: failed to get image descriptor from registry: GET https://api.digitalocean.com/v2/registry/auth?scope=repository%3Astack-radar%2Fstack-radar-client%3Apull&service=registry.digitalocean.com: unexpected status code 401 Unauthorized: {"id": "Unauthorized", "message": "Unable to authenticate you" }
  - oci-model: failed to fetch descriptor: GET https://api.digitalocean.com/v2/registry/auth?scope=repository%3Astack-radar%2Fstack-radar-client%3Apull&service=registry.digitalocean.com: unexpected status code 401 Unauthorized: {"id": "Unauthorized", "message": "Unable to authenticate you" }
`;

const ECR_RATE_LIMIT = `Command failed: syft registry:public.ecr.aws/docker/library/redis@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933 -o cyclonedx-json@1.6=/tmp/sbom-1787651294794-1l7fmoe26ie.json
[0000]  WARN unable to get filesystem cache at /.cache/syft: unable to create directory at '/.cache/syft': mkdir /.cache: read-only file system
[0001] ERROR could not determine source: errors occurred attempting to resolve 'public.ecr.aws/docker/library/redis@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933':
  - oci-registry: failed to get image from registry: GET https://public.ecr.aws/v2/docker/library/redis/manifests/sha256:3f835dae62fe5012baf5a768293967c93bc09cf9e848d415351dfba04ee87537: TOOMANYREQUESTS: Rate exceeded
  - oci-model: not an OCI model artifact (config media type: )
`;

describe("classifyScanFailure", () => {
    it("classifies the DO registry 401 from the 25 Aug log as registry_auth", () => {
        expect(classifyScanFailure(DO_401)).toBe("registry_auth");
    });

    it("classifies the ECR TOOMANYREQUESTS from the 25 Aug log as registry_rate_limited", () => {
        expect(classifyScanFailure(ECR_RATE_LIMIT)).toBe("registry_rate_limited");
    });

    it("classifies Docker Hub's pull-access-denied phrasing as registry_auth", () => {
        expect(
            classifyScanFailure(
                "Command failed: syft registry:acme/private:1.0\nErrors:\n  - oci-registry: DENIED: requested access to the resource is denied"
            )
        ).toBe("registry_auth");
    });

    it("classifies GHCR's UNAUTHORIZED phrasing as registry_auth", () => {
        expect(
            classifyScanFailure(
                "GET https://ghcr.io/token?scope=repository%3Aacme%2Fapp%3Apull: UNAUTHORIZED: authentication required"
            )
        ).toBe("registry_auth");
    });

    it("falls back to scan_error for anything unrecognised", () => {
        expect(classifyScanFailure("Command failed: syft … \nsignal SIGKILL")).toBe("scan_error");
        expect(classifyScanFailure("ETIMEDOUT connecting to registry")).toBe("scan_error");
        expect(classifyScanFailure("")).toBe("scan_error");
    });

    it("does not read a 401 out of hex or timestamps", () => {
        // Digests and temp-file names carry arbitrary digit runs; a bare
        // numeric match would turn an unrelated failure into a credentials
        // banner. The numeric forms only count behind "status code".
        expect(
            classifyScanFailure(
                "could not resolve 'ghcr.io/acme/app@sha256:4013f835dae62fe5012baf5a768293967c93bc09cf9e848d415351dfba04ee87ab': connection reset (temp /tmp/sbom-1787654012345-x.json)"
            )
        ).toBe("scan_error");
    });

    it("prefers registry_auth when a message somehow says both", () => {
        expect(
            classifyScanFailure("TOOMANYREQUESTS after retry; final: UNAUTHORIZED: authentication required")
        ).toBe("registry_auth");
    });
});
