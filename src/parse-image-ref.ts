/**
 * Parses an image display name into its components.
 *
 * `tag` is undefined when the ref carries no tag. Defaulting to "latest" would
 * be inventing one: a digest-pinned deployment (Flux/Argo image automation,
 * Kustomize `images[].digest`) has no tag at all, and labelling every distinct
 * image "latest" makes them indistinguishable in the UI. For a bare `nginx` it
 * is the *registry* that resolves the missing tag to `latest`, not us.
 *
 * Examples:
 *   "nginx:1.25"                        → { projectName: "nginx",         tag: "1.25",      registry: undefined }
 *   "docker.io/library/nginx:1.25"      → { projectName: "library/nginx", tag: "1.25",      registry: "docker.io" }
 *   "myregistry.io/team/myapp:v2.3.1"  → { projectName: "team/myapp",    tag: "v2.3.1",    registry: "myregistry.io" }
 *   "nginx"                             → { projectName: "nginx",         tag: undefined,   registry: undefined }
 *   "nginx@sha256:abc"                  → { projectName: "nginx",         tag: undefined,   registry: undefined }
 *   "nginx:1.25@sha256:abc"             → { projectName: "nginx",         tag: "1.25",      registry: undefined }
 *   "localhost:5000/myapp:dev"          → { projectName: "myapp",         tag: "dev",       registry: "localhost:5000" }
 *   "sha256:a4a8…" (64 hex)             → { projectName: "",              tag: undefined,   registry: undefined }
 */

/**
 * A bare image ID. When a pod is pinned by digest and the runtime has no tag
 * to report, containerd fills `containerStatus.image` with the image *config*
 * hash — `sha256:` plus 64 hex, no name at all. Naively splitting that on the
 * colon turns the hex into a "tag", which is how 64-character tags reached the
 * UI. It identifies nothing pullable, so no part of it survives parsing.
 */
const BARE_IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;

export function isBareImageId(ref: string): boolean {
    return BARE_IMAGE_ID.test(ref);
}

export function parseImageRef(displayName: string): { projectName: string; tag: string | undefined; registry: string | undefined } {
    // Strip digest (@sha256:...)
    let ref = displayName;
    const digestIdx = ref.indexOf("@");
    if (digestIdx !== -1) {
        ref = ref.slice(0, digestIdx);
    }

    // Checked *after* the digest strip so `sha256:…@sha256:…` — a bare image
    // ID that had a digest appended to it — is caught too.
    if (BARE_IMAGE_ID.test(ref)) {
        return { projectName: "", tag: undefined, registry: undefined };
    }

    // Extract tag: colon after the last slash (avoids port colons in registry hostnames)
    let tag: string | undefined;
    const lastSlash = ref.lastIndexOf("/");
    const colonIdx = ref.indexOf(":", lastSlash + 1);
    if (colonIdx !== -1) {
        tag = ref.slice(colonIdx + 1);
        ref = ref.slice(0, colonIdx);
    }

    // Strip registry hostname (first path component if it contains '.' or ':')
    const parts = ref.split("/");
    let registry: string | undefined;
    if (parts.length > 1) {
        const first = parts[0]!;
        if (first.includes(".") || first.includes(":") || first === "localhost") {
            registry = parts.shift();
        }
    }

    return { projectName: parts.join("/"), tag, registry };
}
