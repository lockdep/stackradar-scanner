import * as fs from "fs";
import { redactProxyCredentials } from "./proxy.js";

/**
 * Image facts the SBOM upload carries beside syft's package list: the ordered
 * layer list with the Dockerfile line that made each layer, and a short,
 * literal set of facts from the image config and manifest.
 *
 * Why they exist: CycloneDX from syft names the *layer* every package lives in
 * (`syft:location:N:layerID`) but carries no ordered layer list, so nothing
 * downstream can tell a base-image layer from one your own Dockerfile added.
 * With the order — and the base-image annotations Docker Official Images set
 * on the manifest — StackRadar can say "these 231 findings are the base
 * image's, and rebuilding on the newer tag removes 212 of them".
 *
 * **This module is a disclosure boundary**, in the same sense as the label
 * allowlists in `scan.ts`: README.md § "What leaves your cluster" lists every
 * property below by name, and `image-metadata.test.ts` snapshots the set, so
 * widening it is a visible diff in a test. Three rules hold it:
 *
 *   1. `createdBy` is redacted here, before it is sent ({@link redactCreatedBy}).
 *      It is the one real secret-leak vector in an image config.
 *   2. `entrypoint` / `cmd` are `argv[0]` only — the executable path. People
 *      bake `--api-key=…` into `CMD`.
 *   3. `config.Env` is never sent, except keys matching
 *      {@link ENV_VERSION_KEY} (`NODE_VERSION`, `JAVA_VERSION`, …).
 *
 * `STACKRADAR_IMAGE_METADATA=false` (Helm: `scanner.imageMetadata`) turns all
 * of it off: the upload is then syft's CycloneDX and nothing else.
 */

export const IMAGE_METADATA_ENABLED = (process.env.STACKRADAR_IMAGE_METADATA ?? "true") !== "false";

/** The only `config.Env` keys that ever leave the cluster. */
export const ENV_VERSION_KEY = /^[A-Z0-9_]+_VERSION$/;

/** `createdBy` is cut to this many characters after redaction. */
export const CREATED_BY_MAX_LENGTH = 200;

/**
 * Every property name this module can emit. `N` is a history index, `KEY` an
 * env key matching {@link ENV_VERSION_KEY}. Exported for the snapshot test
 * and for README.md, which must list exactly these.
 */
export const IMAGE_METADATA_PROPERTY_NAMES = [
    "stackradar:layer:N:diffId",
    "stackradar:layer:N:createdBy",
    "stackradar:layer:N:emptyLayer",
    "stackradar:layer:N:size",
    "stackradar:layer:N:created",
    "stackradar:image:created",
    "stackradar:image:entrypoint",
    "stackradar:image:cmd",
    "stackradar:image:baseName",
    "stackradar:image:baseDigest",
    "stackradar:image:source",
    "stackradar:image:version",
    "stackradar:image:revision",
    "stackradar:image:vendor",
    "stackradar:image:title",
    "stackradar:image:url",
    "stackradar:image:licenses",
    "stackradar:image:official",
    "stackradar:image:buildpackRunImage",
    "stackradar:image:buildpackTopLayer",
    "stackradar:image:env:KEY",
    "stackradar:image:user",
    "stackradar:image:architecture",
    "stackradar:image:os",
    "stackradar:image:variant",
] as const;

/**
 * OCI keys read from the manifest annotations first and the config labels
 * second. Annotations first because that is where Docker Official Images put
 * them: `nginx:1.27` carries `org.opencontainers.image.base.name` on its
 * manifest while its config labels hold only `maintainer`.
 */
const OCI_KEYS: ReadonlyArray<[property: string, ociKey: string]> = [
    ["stackradar:image:baseName", "org.opencontainers.image.base.name"],
    ["stackradar:image:baseDigest", "org.opencontainers.image.base.digest"],
    ["stackradar:image:source", "org.opencontainers.image.source"],
    ["stackradar:image:version", "org.opencontainers.image.version"],
    ["stackradar:image:revision", "org.opencontainers.image.revision"],
    ["stackradar:image:vendor", "org.opencontainers.image.vendor"],
    ["stackradar:image:title", "org.opencontainers.image.title"],
    ["stackradar:image:url", "org.opencontainers.image.url"],
    ["stackradar:image:licenses", "org.opencontainers.image.licenses"],
];

/** Values are facts about an image, not prose; anything longer is cut. */
const VALUE_MAX_LENGTH = 512;

// ─── createdBy redaction ─────────────────────────────────────────────────────

const SECRET_KEY = /((?:token|secret|password|passwd|key|auth|credential)[^\s=:]*\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?\S+/gi;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+\S+/g;
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
/** `|1 NPM_TOKEN=… /bin/sh -c …` — how pre-BuildKit builders, and BuildKit's `RUN |1 …`, record build args. */
const ARG_PREFIX = /^(RUN\s+)?\|\d+\s+/;
const SHELL_FORM = /\/bin\/(?:ba)?sh -c |cmd \/S \/C /;
/** `CMD ["nginx" "-g" …]`, with or without the legacy `/bin/sh -c #(nop)` lead-in. */
const ARGV_INSTRUCTION = /^(?:\/bin\/sh -c #\(nop\)\s+)?(CMD|ENTRYPOINT)\s+\[\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Make one image-history line safe to send.
 *
 * A Dockerfile line is where build-time secrets end up: a `curl -H
 * "Authorization: Bearer …"`, an `--password=` flag, an artifact URL with
 * `user:token@`, and — from builders that record build args — a literal
 * `|1 NPM_TOKEN=… /bin/sh -c npm ci` prefix. The server needs the instruction
 * verb and enough of the line to recognise it (`RUN npm ci`), nothing more.
 *
 * A `CMD` / `ENTRYPOINT` line is cut to the instruction and its `argv[0]`
 * first: history repeats the whole command, and its arguments are exactly
 * what `stackradar:image:cmd` withholds.
 *
 * Then, in order: drop the build-arg prefix whole; mask the value after anything
 * that names a secret; mask `Bearer` / `Basic` credentials wherever they
 * stand; redact URL userinfo; cap the length. Over-redaction (a masked
 * `GPG_KEY=` fingerprint) is the accepted cost of never under-redacting.
 */
export function redactCreatedBy(line: string): string {
    const argv = ARGV_INSTRUCTION.exec(line);
    if (argv) return `${argv[1]} ["${argv[2]}"]`.slice(0, CREATED_BY_MAX_LENGTH);
    if (/^(?:\/bin\/sh -c #\(nop\)\s+)?(?:CMD|ENTRYPOINT)\b/.test(line)) {
        // A form this does not recognise: the verb alone is enough, and safe.
        return /ENTRYPOINT/.test(line.slice(0, 40)) ? "ENTRYPOINT" : "CMD";
    }

    let out = line;

    const prefix = ARG_PREFIX.exec(out);
    if (prefix) {
        const rest = out.slice(prefix[0].length);
        const shell = SHELL_FORM.exec(rest);
        // The arg values may contain spaces, so they are not tokenised: cut
        // to the shell invocation when there is one, else drop `KEY=…` tokens.
        const command = shell ? rest.slice(shell.index) : rest.replace(/^(?:\S+=\S*\s+)+/, "");
        out = `${prefix[1] ?? ""}${command}`;
    }

    out = out
        .replace(SECRET_KEY, "$1***")
        .replace(AUTH_SCHEME, "$1 ***")
        .replace(URL_TOKEN, (url) => redactProxyCredentials(url));

    return out.length > CREATED_BY_MAX_LENGTH ? out.slice(0, CREATED_BY_MAX_LENGTH) : out;
}

// ─── Reading syft's second output ────────────────────────────────────────────

/**
 * The byte range of one top-level key's value in a JSON file, read in chunks.
 *
 * syft-json for a large image is tens of megabytes of artifacts and file
 * records, and the only part wanted is `source` (a few tens of kilobytes). A
 * `JSON.parse` of the whole document would cost several times its size in
 * heap, per concurrent scan, to read one key — so this walks the bytes with
 * just enough of a JSON lexer to know depth and string state, and copies out
 * the value it was asked for.
 */
export function extractTopLevelValue(file: string, key: string): string | null {
    const fd = fs.openSync(file, "r");
    try {
        const chunk = Buffer.alloc(64 * 1024);
        let depth = 0;
        let inString = false;
        let escaped = false;
        let token: number[] = [];       // bytes of the string being read at depth 1
        let lastString: string | null = null;
        let capturing = false;
        let captured: number[] = [];
        let captureDepth = 0;
        let awaitingValue = false;

        for (;;) {
            const read = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (read === 0) break;
            for (let i = 0; i < read; i++) {
                const byte = chunk[i]!;

                if (capturing) captured.push(byte);

                if (inString) {
                    if (escaped) escaped = false;
                    else if (byte === 0x5c) escaped = true;          // backslash
                    else if (byte === 0x22) {                        // closing quote
                        inString = false;
                        if (!capturing && depth === 1) lastString = Buffer.from(token).toString("utf8");
                    } else if (!capturing && depth === 1) token.push(byte);
                    continue;
                }

                if (byte === 0x22) {                                 // opening quote
                    inString = true;
                    token = [];
                    continue;
                }
                if (byte === 0x7b || byte === 0x5b) {                // { [
                    if (awaitingValue && !capturing) {
                        capturing = true;
                        awaitingValue = false;
                        captured = [byte];
                        captureDepth = depth;
                    }
                    depth++;
                    continue;
                }
                if (byte === 0x7d || byte === 0x5d) {                // } ]
                    depth--;
                    if (capturing && depth === captureDepth) {
                        return Buffer.from(captured).toString("utf8");
                    }
                    continue;
                }
                if (byte === 0x3a && depth === 1 && !capturing) {    // colon after a top-level key
                    awaitingValue = lastString === key;
                    continue;
                }
                if (awaitingValue && !capturing && byte > 0x20) {
                    // The key's value is a scalar, not the object this reads.
                    return null;
                }
            }
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

interface SyftLayer {
    digest?: string;
    size?: number;
}

interface HistoryEntry {
    created?: string;
    created_by?: string;
    empty_layer?: boolean;
}

interface ImageConfig {
    architecture?: string;
    os?: string;
    variant?: string;
    created?: string;
    history?: HistoryEntry[];
    rootfs?: { diff_ids?: string[] };
    config?: {
        Env?: string[];
        Entrypoint?: string[] | null;
        Cmd?: string[] | null;
        Labels?: Record<string, string> | null;
        User?: string;
    };
}

/** What {@link readLayerMetadata} hands back: the parts of `source.metadata` this module reads. */
export interface ImageSourceMetadata {
    layers: SyftLayer[];
    config: ImageConfig | null;
    annotations: Record<string, string>;
}

function decodeBase64Json<T>(value: unknown): T | null {
    if (typeof value !== "string" || value === "") return null;
    try {
        return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
    } catch {
        return null;
    }
}

/**
 * Read `source.metadata` out of a syft-json document: the ordered layers
 * (`digest` is the diff id `syft:location:N:layerID` names), the raw image
 * config and the manifest's annotations. Null when the document has no image
 * source — the caller then uploads the SBOM as syft wrote it.
 */
export function readLayerMetadata(metaFile: string): ImageSourceMetadata | null {
    const raw = extractTopLevelValue(metaFile, "source");
    if (!raw) return null;

    let source: { metadata?: { layers?: SyftLayer[]; config?: unknown; manifest?: unknown } };
    try {
        source = JSON.parse(raw);
    } catch {
        return null;
    }
    const metadata = source.metadata;
    if (!metadata || !Array.isArray(metadata.layers)) return null;

    const manifest = decodeBase64Json<{ annotations?: Record<string, string> }>(metadata.manifest);
    return {
        layers: metadata.layers,
        config: decodeBase64Json<ImageConfig>(metadata.config),
        annotations: manifest?.annotations ?? {},
    };
}

// ─── Building the properties ─────────────────────────────────────────────────

export interface CycloneDxProperty {
    name: string;
    value: string;
}

function cut(value: string): string {
    return value.length > VALUE_MAX_LENGTH ? value.slice(0, VALUE_MAX_LENGTH) : value;
}

/**
 * `argv[0]` of an exec-form array; the shell form's `/bin/sh` is its honest answer.
 *
 * With an `ENTRYPOINT` set, `CMD` is that entrypoint's default *arguments*
 * (`--config.file=/etc/prometheus/prometheus.yml`), and arguments are what
 * this withholds. It is an executable only behind an init wrapper
 * (`dumb-init`, then `/nginx-ingress-controller`), so: anything that starts
 * like a flag, or carries a `=`, is not sent.
 */
function argv0(argv: string[] | null | undefined): string | null {
    const first = argv?.[0];
    if (typeof first !== "string" || first === "") return null;
    return first.startsWith("-") || first.includes("=") ? null : first;
}

/**
 * The `stackradar:*` properties for one image, in a stable order.
 *
 * Layers are indexed by **history entry**, so the empty ones (`ENV`, `CMD`,
 * `LABEL`) keep their place — the base-image boundary heuristic reads them —
 * and `diffId` / `size` are present only on entries that produced a layer.
 * An image whose history does not account for its layers (some builders write
 * none) gets one bare entry per layer instead: order and diff ids, no lines.
 */
export function imageProperties(meta: ImageSourceMetadata): CycloneDxProperty[] {
    const props: CycloneDxProperty[] = [];
    const add = (name: string, value: string | null | undefined) => {
        if (value !== null && value !== undefined && value !== "") props.push({ name, value: cut(value) });
    };

    const config = meta.config;
    const history = config?.history ?? [];
    const producing = history.filter((h) => h.empty_layer !== true).length;

    if (history.length > 0 && producing === meta.layers.length) {
        let layer = 0;
        history.forEach((entry, n) => {
            const empty = entry.empty_layer === true;
            add(`stackradar:layer:${n}:emptyLayer`, String(empty));
            if (!empty) {
                const l = meta.layers[layer++]!;
                add(`stackradar:layer:${n}:diffId`, l.digest);
                if (typeof l.size === "number") add(`stackradar:layer:${n}:size`, String(l.size));
            }
            if (entry.created_by) add(`stackradar:layer:${n}:createdBy`, redactCreatedBy(entry.created_by));
            add(`stackradar:layer:${n}:created`, entry.created);
        });
    } else {
        meta.layers.forEach((l, n) => {
            add(`stackradar:layer:${n}:emptyLayer`, "false");
            add(`stackradar:layer:${n}:diffId`, l.digest);
            if (typeof l.size === "number") add(`stackradar:layer:${n}:size`, String(l.size));
        });
    }

    const labels = config?.config?.Labels ?? {};
    const oci = (key: string): string | undefined => meta.annotations[key] ?? labels[key];

    add("stackradar:image:created", config?.created);
    add("stackradar:image:entrypoint", argv0(config?.config?.Entrypoint));
    add("stackradar:image:cmd", argv0(config?.config?.Cmd));
    for (const [property, key] of OCI_KEYS) {
        const value = oci(key);
        // `source` and `url` are URLs people do put credentials in.
        add(property, value === undefined ? undefined : redactUrlsIn(value));
    }
    if (Object.keys(meta.annotations).some((k) => k.startsWith("com.docker.official-images."))) {
        add("stackradar:image:official", "true");
    }

    const lifecycle = buildpackRunImage(labels["io.buildpacks.lifecycle.metadata"]);
    add("stackradar:image:buildpackRunImage", lifecycle?.reference);
    add("stackradar:image:buildpackTopLayer", lifecycle?.topLayer);

    for (const entry of config?.config?.Env ?? []) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const key = entry.slice(0, eq);
        if (ENV_VERSION_KEY.test(key)) add(`stackradar:image:env:${key}`, entry.slice(eq + 1));
    }

    // Sent even when empty would be the answer worth having — but `add` drops
    // empties, so "image defaults to root" is the absence of this property.
    add("stackradar:image:user", config?.config?.User);
    add("stackradar:image:architecture", config?.architecture);
    add("stackradar:image:os", config?.os);
    add("stackradar:image:variant", config?.variant);

    return props;
}

function redactUrlsIn(value: string): string {
    return value.replace(URL_TOKEN, (url) => redactProxyCredentials(url));
}

/** `runImage.reference` / `runImage.topLayer` out of the Cloud Native Buildpacks lifecycle label. */
function buildpackRunImage(label: string | undefined): { reference?: string; topLayer?: string } | null {
    if (!label) return null;
    try {
        const parsed = JSON.parse(label) as { runImage?: { reference?: unknown; topLayer?: unknown } };
        const run = parsed.runImage;
        if (!run) return null;
        return {
            ...(typeof run.reference === "string" ? { reference: run.reference } : {}),
            ...(typeof run.topLayer === "string" ? { topLayer: run.topLayer } : {}),
        };
    } catch {
        return null;
    }
}

// ─── Merging into the CycloneDX document ─────────────────────────────────────

/**
 * Put the properties on `metadata.component.properties` of the CycloneDX file,
 * in place. A parse and a stringify of a document the server caps at 10 MB —
 * deliberately not a pass through a CycloneDX library, which would re-model
 * and re-serialise everything syft wrote. Returns false, leaving the file as
 * syft wrote it, when the document has no `metadata.component` to carry them.
 */
export function mergeImageProperties(sbomFile: string, properties: CycloneDxProperty[]): boolean {
    if (properties.length === 0) return false;
    const bom = JSON.parse(fs.readFileSync(sbomFile, "utf8")) as {
        metadata?: { component?: { properties?: CycloneDxProperty[] } };
    };
    const component = bom.metadata?.component;
    if (!component || typeof component !== "object") return false;

    const kept = (component.properties ?? []).filter((p) => !p.name.startsWith("stackradar:"));
    component.properties = [...kept, ...properties];
    fs.writeFileSync(sbomFile, JSON.stringify(bom));
    return true;
}
