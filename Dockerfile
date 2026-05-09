FROM node:22-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Install syft (pinned version for reproducibility)
ARG SYFT_VERSION=1.19.0
RUN apk add --no-cache curl ca-certificates && \
    curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh \
      | sh -s -- -b /usr/local/bin "v${SYFT_VERSION}" && \
    apk del curl && \
    syft version

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

USER node
CMD ["node", "dist/src/index.js"]
