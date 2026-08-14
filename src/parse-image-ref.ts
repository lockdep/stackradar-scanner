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
 */
export function parseImageRef(displayName: string): { projectName: string; tag: string | undefined; registry: string | undefined } {
    // Strip digest (@sha256:...)
    let ref = displayName;
    const digestIdx = ref.indexOf("@");
    if (digestIdx !== -1) {
        ref = ref.slice(0, digestIdx);
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
