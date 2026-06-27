FROM node:22-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd

ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.6.1
ARG CLOUDFLARED_AMD64_SHA256=5861a10a438fe8ddcfebb3b830f83966cbf193edafce0fe2eeb198fbae1f7a22
ARG CLOUDFLARED_ARM64_SHA256=59816ce9b16db71f5bc2a86d59b3632a96c8c3ee934bde2bc8641ee83a6070eb

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN apk add --no-cache \
    ca-certificates \
    chromium \
    harfbuzz \
    nss \
    ttf-freefont \
    wget

RUN set -eux; \
    case "${TARGETARCH}" in \
      "amd64") cloudflared_arch="amd64"; expected_sha="${CLOUDFLARED_AMD64_SHA256}" ;; \
      "arm64") cloudflared_arch="arm64"; expected_sha="${CLOUDFLARED_ARM64_SHA256}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH:-<unset>}" >&2; exit 1 ;; \
    esac; \
    wget -O /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cloudflared_arch}"; \
    echo "${expected_sha}  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev

COPY src ./src

RUN npm run build && npm prune --omit=dev

RUN chown -R node:node /app

USER node

EXPOSE 3099

CMD ["node", "dist/index.js"]
