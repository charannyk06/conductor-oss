FROM rust:1.85 as builder
WORKDIR /app
COPY . .
RUN cargo build --release -p conductor-relay

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/conductor-relay /usr/local/bin/conductor-relay
EXPOSE 8080
CMD ["conductor-relay"]
