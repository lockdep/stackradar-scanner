# pnpm is resolved by corepack from the `packageManager` field in package.json,
# so the build uses one pinned version instead of whatever `npm i -g pnpm`
# happens to resolve to that day.
#
# The base image is pinned by digest for the same reason: `22-alpine` is a
# moving tag, so two builds of the same commit could otherwise ship different
# base layers — and different CVEs in the SBOM customers scan. Renovate raises a
# PR when the tag moves, which makes each base-layer change a reviewable commit.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# Runtime dependencies only, resolved from the same lockfile. Shipping the build
# toolchain (typescript, vitest, tsx) in the runtime image would put packages the
# scanner never loads into its own SBOM, so every customer scanning this agent
# would see CVEs for code that is not on any execution path.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ── Syft ─────────────────────────────────────────────────────────────────────
# Syft is fetched from its release and verified before it is used, rather than
# installed by piping anchore/syft's install.sh from `main` into a shell. That
# branch is a mutable ref, so pinning SYFT_VERSION did not pin what actually ran
# at build time — and what ran, ran as root inside the build of an agent that
# gets cluster-wide read in customer clusters.
#
# Trust chain: apk's signed index vouches for cosign, cosign verifies Anchore's
# release signature over checksums.txt, and checksums.txt fixes the bytes of the
# tarball. Nothing downloaded here is executed before it has been verified.
FROM base AS syft
# renovate: datasource=github-releases depName=anchore/syft
ARG SYFT_VERSION=1.19.0
# Filled in by BuildKit from the target platform. It must be declared without a
# default: a default value shadows the builder's, and the build would then pull
# an amd64 binary for an arm64 image. The fallback below is for the legacy
# builder, which sets nothing.
ARG TARGETARCH
RUN apk add --no-cache curl cosign
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    url="https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}"; \
    tarball="syft_${SYFT_VERSION}_linux_${arch}.tar.gz"; \
    sums="syft_${SYFT_VERSION}_checksums.txt"; \
    cd /tmp; \
    curl -sSfL -O "${url}/${tarball}"; \
    curl -sSfL -O "${url}/${sums}"; \
    curl -sSfL -O "${url}/${sums}.pem"; \
    curl -sSfL -O "${url}/${sums}.sig"; \
    cosign verify-blob \
      --certificate "${sums}.pem" \
      --signature "${sums}.sig" \
      --certificate-identity-regexp '^https://github\.com/anchore/syft/\.github/workflows/release\.yaml@' \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "${sums}"; \
    grep " ${tarball}\$" "${sums}" | sha256sum -c -; \
    tar -xzf "${tarball}" syft; \
    install -m 0755 syft /usr/local/bin/syft; \
    syft version

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner

# syft is a static Go binary, but it uses the system trust store rather than a
# bundled one, so it needs ca-certificates to reach registries over TLS.
#
# The chart's `caBundle` values depend on this staying true: they add a private
# CA by extending the trust store (`SSL_CERT_DIR` for syft, `NODE_EXTRA_CA_CERTS`
# for Node) rather than replacing it, so removing this package would take the
# public roots with it and leave a cluster behind a TLS-intercepting proxy able
# to reach its own registry and nothing else.
RUN apk add --no-cache ca-certificates
COPY --from=syft /usr/local/bin/syft /usr/local/bin/syft

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
# package.json is kept so the image self-describes: `type: module` is required
# for Node to load the compiled ESM output, and SBOM scanners read the name and
# version from it.
COPY --from=builder /app/package.json ./package.json
# The license's Notices section requires the terms to travel with any copy of
# the software, and this image is a copy.
COPY --from=builder /app/LICENSE.md ./LICENSE.md

USER node
CMD ["node", "dist/src/watch.js"]
