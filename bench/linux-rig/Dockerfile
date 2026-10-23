# node:26-bookworm-slim, pinned to its multi-arch index digest.
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe

# strace + linux-perf back the kernel-level rig (`run-syscalls.sh`); the rest is the throughput rig.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip util-linux procps strace linux-perf \
    && rm -rf /var/lib/apt/lists/*

# The tools below are linux aarch64 release files, each checked against its published SHA-256.

# bun (match host 1.4.4)
RUN curl -fsSL -o /tmp/bun.zip \
    https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip \
    && echo "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun \
    && ln -sf bun /usr/local/bin/bunx \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-aarch64

# deno (match host 2.9.7)
RUN curl -fsSL -o /tmp/deno.zip \
    https://github.com/denoland/deno/releases/download/v2.9.7/deno-aarch64-unknown-linux-gnu.zip \
    && echo "c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf  /tmp/deno.zip" | sha256sum -c - \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/deno \
    && ln -sf /usr/local/bin/deno /usr/bin/deno \
    && rm /tmp/deno.zip

# oha - must match the host version the harness is written against: run.ts passes
# `--output-format json`, which older oha rejects, and a rejected flag reads as a 0 rps row.
RUN curl -fsSL -o /usr/local/bin/oha \
    https://github.com/hatoo/oha/releases/download/v1.14.0/oha-linux-arm64 \
    && echo "e0497f3304b18350f4e64de557372fd48e06768c970abaa7904c0a590670221a  /usr/local/bin/oha" | sha256sum -c - \
    && chmod +x /usr/local/bin/oha

WORKDIR /repo
CMD ["bash"]
