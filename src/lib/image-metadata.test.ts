import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
    CREATED_BY_MAX_LENGTH,
    ENV_VERSION_KEY,
    IMAGE_METADATA_PROPERTY_NAMES,
    extractTopLevelValue,
    imageProperties,
    mergeImageProperties,
    readLayerMetadata,
    redactCreatedBy,
    type ImageSourceMetadata,
} from "./image-metadata.js";
import { SYFT_SCOPE, syftArgs, attachImageMetadata } from "./scan.js";

// Like the label allowlists in scan.test.ts, these tests guard the boundary
// README.md describes to customers: which image facts leave their cluster,
// and that nothing secret rides along. The assertions are as much about what
// is *dropped* as what is kept.

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/nginx-1.27-alpine.syft-source.json");

const tmpFiles: string[] = [];
function tmp(name: string, content: string): string {
    const file = path.join(os.tmpdir(), `image-metadata-test-${process.pid}-${tmpFiles.length}-${name}`);
    fs.writeFileSync(file, content);
    tmpFiles.push(file);
    return file;
}
afterEach(() => {
    for (const f of tmpFiles.splice(0)) try { fs.unlinkSync(f); } catch { /* already gone */ }
});

describe("the emitted property set", () => {
    // A snapshot, not an equality assertion: adding a property produces a diff
    // a reviewer has to accept on purpose — and has to mirror in README.md.
    it("is exactly these names", () => {
        expect([...IMAGE_METADATA_PROPERTY_NAMES]).toMatchInlineSnapshot(`
          [
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
          ]
        `);
    });

    it("keeps only env keys ending _VERSION", () => {
        expect(String(ENV_VERSION_KEY)).toBe("/^[A-Z0-9_]+_VERSION$/");
    });

    it("emits nothing outside the declared set", () => {
        const declared = new Set<string>(IMAGE_METADATA_PROPERTY_NAMES);
        const generalise = (name: string) =>
            name.replace(/^stackradar:layer:\d+:/, "stackradar:layer:N:").replace(/^stackradar:image:env:.+$/, "stackradar:image:env:KEY");
        const meta = readLayerMetadata(FIXTURE)!;
        for (const p of imageProperties(meta)) expect(declared.has(generalise(p.name)), p.name).toBe(true);
    });
});

describe("redactCreatedBy", () => {
    const TABLE: Array<[label: string, input: string, expected: string]> = [
        ["a plain line passes through unchanged", "RUN npm ci", "RUN npm ci"],
        ["BuildKit's comment survives", "RUN /bin/sh -c npm ci # buildkit", "RUN /bin/sh -c npm ci # buildkit"],
        [
            "the legacy ARG prefix is dropped whole",
            "|1 NPM_TOKEN=npm_s3cr3t /bin/sh -c npm ci",
            "/bin/sh -c npm ci",
        ],
        [
            "BuildKit's RUN |N prefix too, values with spaces included",
            "RUN |2 NPM_TOKEN=npm_s3cr3t GREETING=hello world /bin/sh -c npm ci # buildkit",
            "RUN /bin/sh -c npm ci # buildkit",
        ],
        [
            "an Authorization header",
            'RUN curl -H "Authorization: Bearer ghp_abc123" https://example.com/a.tgz',
            'RUN curl -H "Authorization: *** https://example.com/a.tgz',
        ],
        ["a bare Bearer credential", "RUN wget --header 'X-Thing: Bearer abc.def'", "RUN wget --header 'X-Thing: Bearer ***"],
        ["a --password= flag", "RUN mvn deploy --password=hunter2 -DskipTests", "RUN mvn deploy --password=*** -DskipTests"],
        ["an inline env assignment", "RUN API_KEY=abc123 ./build.sh", "RUN API_KEY=*** ./build.sh"],
        [
            "URL userinfo",
            "RUN pip install --index-url https://ci:t0ken@pypi.corp.example/simple app",
            "RUN pip install --index-url https://***@pypi.corp.example/simple app",
        ],
        ["a CMD keeps its verb and argv[0] only", 'CMD ["app" "--api-key=abc123" "--port" "80"]', 'CMD ["app"]'],
        [
            "the legacy nop form of an ENTRYPOINT too",
            '/bin/sh -c #(nop)  ENTRYPOINT ["/entry.sh" "--token" "hunter2"]',
            'ENTRYPOINT ["/entry.sh"]',
        ],
        ["a shell-form CMD is its verb", "CMD /bin/sh -c app --token hunter2", "CMD"],
        ["a keyserver flag is not a secret", "RUN gpg --keyserver hkps://keys.openpgp.org --recv-keys ABCD", "RUN gpg --keyserver hkps://keys.openpgp.org --recv-keys ABCD"],
    ];

    it.each(TABLE)("%s", (_label, input, expected) => {
        expect(redactCreatedBy(input)).toBe(expected);
    });

    it("never lets the secret through, whatever the output looks like", () => {
        for (const [, input] of TABLE) {
            const out = redactCreatedBy(input);
            for (const secret of ["npm_s3cr3t", "ghp_abc123", "abc.def", "hunter2", "abc123", "t0ken"]) {
                expect(out).not.toContain(secret);
            }
        }
    });

    it("caps the line after redaction", () => {
        const out = redactCreatedBy(`RUN echo ${"x".repeat(1000)}`);
        expect(out).toHaveLength(CREATED_BY_MAX_LENGTH);
    });
});

describe("extractTopLevelValue", () => {
    it("copies out one top-level object without parsing the rest", () => {
        const file = tmp("doc.json", JSON.stringify({
            artifacts: [{ name: 'tricky "source": {', nested: { source: { wrong: true } } }],
            source: { id: "abc", metadata: { layers: [{ digest: "sha256:1" }], note: "a } in a \\ string" } },
            schema: { version: "16" },
        }));
        expect(JSON.parse(extractTopLevelValue(file, "source")!)).toEqual({
            id: "abc",
            metadata: { layers: [{ digest: "sha256:1" }], note: "a } in a \\ string" },
        });
    });

    it("is null for a missing key or a scalar value", () => {
        const file = tmp("doc.json", JSON.stringify({ source: "a string", other: {} }));
        expect(extractTopLevelValue(file, "source")).toBeNull();
        expect(extractTopLevelValue(file, "absent")).toBeNull();
    });

    it("survives a value that straddles the read buffer", () => {
        const big = "y".repeat(200_000);
        const file = tmp("doc.json", JSON.stringify({ artifacts: [big], source: { big, tail: 1 } }));
        expect(JSON.parse(extractTopLevelValue(file, "source")!).tail).toBe(1);
    });
});

describe("imageProperties — nginx:1.27-alpine as syft 1.42.1 reports it", () => {
    const props = () => {
        const list = imageProperties(readLayerMetadata(FIXTURE)!);
        return { list, get: (name: string) => list.find((p) => p.name === name)?.value };
    };

    it("indexes layers by history entry and keeps the empty ones in place", () => {
        const { list, get } = props();
        const empties = list.filter((p) => p.name.endsWith(":emptyLayer"));
        expect(empties).toHaveLength(19);
        expect(empties.filter((p) => p.value === "false")).toHaveLength(8);
        expect(list.filter((p) => p.name.endsWith(":diffId"))).toHaveLength(8);
        // Entry 0 is the base's ADD; entry 1 is its CMD, which makes no layer.
        expect(get("stackradar:layer:0:diffId")).toBe("sha256:a16e98724c05975ee8c40d8fe389c3481373d34ab20a1cf52ea2accc43f71f4c");
        expect(get("stackradar:layer:0:createdBy")).toContain("ADD alpine-minirootfs");
        expect(get("stackradar:layer:1:emptyLayer")).toBe("true");
        expect(get("stackradar:layer:1:diffId")).toBeUndefined();
    });

    it("reads the base image from the manifest annotations, not the labels", () => {
        const { get } = props();
        expect(get("stackradar:image:baseName")).toBe("nginx:1.27.5-alpine-slim");
        expect(get("stackradar:image:baseDigest")).toMatch(/^sha256:/);
        expect(get("stackradar:image:official")).toBe("true");
        expect(get("stackradar:image:version")).toBe("1.27.5-alpine");
    });

    it("sends argv[0] of the entrypoint and the command, never their arguments", () => {
        const { list, get } = props();
        expect(get("stackradar:image:entrypoint")).toBe("/docker-entrypoint.sh");
        expect(get("stackradar:image:cmd")).toBe("nginx");
        expect(list.some((p) => p.value.includes("daemon off"))).toBe(false);
    });

    it("sends only the _VERSION env keys", () => {
        const { list } = props();
        expect(list.filter((p) => p.name.startsWith("stackradar:image:env:")).map((p) => p.name).sort()).toEqual([
            "stackradar:image:env:NGINX_VERSION",
            "stackradar:image:env:NJS_VERSION",
        ]);
        expect(list.some((p) => p.value.includes("/usr/local/sbin"))).toBe(false);
    });

    it("caps every createdBy", () => {
        const { list } = props();
        for (const p of list.filter((x) => x.name.endsWith(":createdBy"))) {
            expect(p.value.length).toBeLessThanOrEqual(CREATED_BY_MAX_LENGTH);
        }
    });
});

describe("imageProperties — synthetic images", () => {
    const base: ImageSourceMetadata = { layers: [{ digest: "sha256:aa", size: 10 }], config: null, annotations: {} };

    it("falls back to bare layers when the history does not account for them", () => {
        const list = imageProperties({ ...base, config: { history: [] } });
        expect(list).toEqual([
            { name: "stackradar:layer:0:emptyLayer", value: "false" },
            { name: "stackradar:layer:0:diffId", value: "sha256:aa" },
            { name: "stackradar:layer:0:size", value: "10" },
        ]);
    });

    it("keeps a baked-in API key out of the payload", () => {
        const list = imageProperties({
            ...base,
            config: {
                history: [{ created_by: "COPY . /app" }],
                config: {
                    Cmd: ["app", "--api-key=abc"],
                    Entrypoint: null,
                    Env: ["API_KEY=abc", "NODE_VERSION=20.11.1", "node_version=lower"],
                    User: "1001",
                },
            },
        });
        expect(list.find((p) => p.name === "stackradar:image:cmd")?.value).toBe("app");
        expect(list.find((p) => p.name === "stackradar:image:user")?.value).toBe("1001");
        expect(list.find((p) => p.name === "stackradar:image:env:NODE_VERSION")?.value).toBe("20.11.1");
        expect(JSON.stringify(list)).not.toContain("abc");
        expect(JSON.stringify(list)).not.toContain("lower");
    });

    it("does not send a CMD that is the entrypoint's arguments", () => {
        const list = imageProperties({
            ...base,
            config: {
                history: [{ created_by: "COPY . /app" }],
                config: { Entrypoint: ["/bin/server"], Cmd: ["--token=abc", "--listen=:8080"], Env: [], User: "" },
            },
        });
        expect(list.find((p) => p.name === "stackradar:image:entrypoint")?.value).toBe("/bin/server");
        expect(list.find((p) => p.name === "stackradar:image:cmd")).toBeUndefined();
        expect(JSON.stringify(list)).not.toContain("abc");
    });

    it("falls back to config labels, and reads the buildpacks run image", () => {
        const list = imageProperties({
            ...base,
            config: {
                history: [{ created_by: "" }],
                config: {
                    Labels: {
                        "org.opencontainers.image.source": "https://ci:token@github.com/acme/app",
                        "io.buildpacks.lifecycle.metadata": JSON.stringify({
                            runImage: { reference: "index.docker.io/paketobuildpacks/run-jammy-base@sha256:cc", topLayer: "sha256:dd" },
                        }),
                    },
                },
            },
        });
        const get = (name: string) => list.find((p) => p.name === name)?.value;
        expect(get("stackradar:image:source")).toBe("https://***@github.com/acme/app");
        expect(get("stackradar:image:buildpackRunImage")).toContain("run-jammy-base");
        expect(get("stackradar:image:buildpackTopLayer")).toBe("sha256:dd");
        expect(get("stackradar:image:official")).toBeUndefined();
    });
});

describe("the syft invocation", () => {
    it("pins the scope and asks for the second output only when metadata is on", () => {
        expect(SYFT_SCOPE).toBe("deep-squashed");
        expect(syftArgs("nginx@sha256:1", "/tmp/a.json", "/tmp/a.syft.json")).toEqual([
            "registry:nginx@sha256:1",
            "--scope", "deep-squashed",
            "-o", "cyclonedx-json@1.6=/tmp/a.json",
            "-o", "syft-json=/tmp/a.syft.json",
        ]);
        expect(syftArgs("nginx@sha256:1", "/tmp/a.json", null)).toEqual([
            "registry:nginx@sha256:1",
            "--scope", "deep-squashed",
            "-o", "cyclonedx-json@1.6=/tmp/a.json",
        ]);
    });
});

describe("attachImageMetadata", () => {
    const cdx = () => JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        metadata: { component: { type: "container", name: "nginx", properties: [{ name: "stackradar:stale", value: "x" }, { name: "other", value: "kept" }] } },
        components: [],
    });

    it("moves the facts onto metadata.component and deletes the second output", () => {
        const sbomFile = tmp("sbom.json", cdx());
        const metaFile = tmp("meta.json", fs.readFileSync(FIXTURE, "utf8"));
        const attached = attachImageMetadata({ sbomFile, metaFile });

        expect(attached).toBeGreaterThan(40);
        expect(fs.existsSync(metaFile)).toBe(false);
        const names = (JSON.parse(fs.readFileSync(sbomFile, "utf8")).metadata.component.properties as { name: string }[]).map((p) => p.name);
        expect(names).toContain("other");
        expect(names).toContain("stackradar:image:baseName");
        expect(names).not.toContain("stackradar:stale");
    });

    it("leaves syft's document untouched when metadata is off", () => {
        const before = cdx();
        const sbomFile = tmp("sbom.json", before);
        expect(attachImageMetadata({ sbomFile, metaFile: null })).toBe(0);
        expect(fs.readFileSync(sbomFile, "utf8")).toBe(before);
        expect(before).not.toContain("stackradar:layer");
    });

    it("never throws on a second output it cannot read", () => {
        const sbomFile = tmp("sbom.json", cdx());
        const metaFile = tmp("meta.json", "{ not json");
        expect(attachImageMetadata({ sbomFile, metaFile })).toBe(0);
        expect(fs.existsSync(metaFile)).toBe(false);
    });

    it("refuses a document with nowhere to put them", () => {
        const sbomFile = tmp("sbom.json", JSON.stringify({ bomFormat: "CycloneDX", components: [] }));
        expect(mergeImageProperties(sbomFile, [{ name: "stackradar:image:os", value: "linux" }])).toBe(false);
    });
});
