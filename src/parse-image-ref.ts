/**
 * Parses an image display name into its components.
 *
 * Examples:
 *   "nginx:1.25"                        → { projectName: "nginx",         version: "1.25",   registry: undefined }
 *   "docker.io/library/nginx:1.25"      → { projectName: "library/nginx", version: "1.25",   registry: "docker.io" }
 *   "myregistry.io/team/myapp:v2.3.1"  → { projectName: "team/myapp",    version: "v2.3.1", registry: "myregistry.io" }
 *   "nginx"                             → { projectName: "nginx",         version: "latest",  registry: undefined }
 *   "nginx@sha256:abc"                  → { projectName: "nginx",         version: "latest",  registry: undefined }
 *   "localhost:5000/myapp:dev"          → { projectName: "myapp",         version: "dev",     registry: "localhost:5000" }
 */
export function parseImageRef(displayName: string): { projectName: string; version: string; registry: string | undefined } {
    // Strip digest (@sha256:...)
    let ref = displayName;
    const digestIdx = ref.indexOf("@");
    if (digestIdx !== -1) {
        ref = ref.slice(0, digestIdx);
    }

    // Extract tag: colon after the last slash (avoids port colons in registry hostnames)
    let version = "latest";
    const lastSlash = ref.lastIndexOf("/");
    const colonIdx = ref.indexOf(":", lastSlash + 1);
    if (colonIdx !== -1) {
        version = ref.slice(colonIdx + 1);
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

    return { projectName: parts.join("/"), version, registry };
}
