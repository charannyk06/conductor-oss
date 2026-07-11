FROM rust:1.88@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS builder
WORKDIR /app
COPY . .
RUN cargo build --locked --release -p conductor-relay

FROM debian:bookworm-slim@sha256:96e378d7e6531ac9a15ad505478fcc2e69f371b10f5cdf87857c4b8188404716
ARG CONDUCTOR_BUILD_SHA=unknown
RUN useradd --system --create-home --home-dir /var/lib/conductor-relay --shell /usr/sbin/nologin conductor \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/conductor-relay /usr/local/bin/conductor-relay
RUN mkdir -p /var/lib/conductor-relay \
    && chown -R conductor:conductor /var/lib/conductor-relay /usr/local/bin/conductor-relay
USER conductor
WORKDIR /var/lib/conductor-relay
ENV RELAY_STATE_FILE=/var/lib/conductor-relay/state.json
ENV CONDUCTOR_BUILD_SHA=${CONDUCTOR_BUILD_SHA}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD sh -ec 'target="${RELAY_BIND_ADDR:-0.0.0.0:8080}"; host="${target%:*}"; port="${target##*:}"; if [ -z "$host" ] || [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ] || [ "$host" = "[::]" ]; then host="127.0.0.1"; fi; curl -fsS "http://$host:$port/health" || exit 1'
CMD ["conductor-relay"]
