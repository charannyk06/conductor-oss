FROM node:22-alpine

ARG TARGETARCH

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
      "arm64") cloudflared_arch="arm64" ;; \
      *) cloudflared_arch="amd64" ;; \
    esac; \
    wget -O /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflared_arch}"; \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --include=dev

COPY src ./src

RUN npm run build && npm prune --omit=dev

EXPOSE 3099

CMD ["node", "dist/index.js"]
