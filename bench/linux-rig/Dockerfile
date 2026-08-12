FROM node:26-bookworm-slim

# strace + linux-perf back the kernel-level rig (`run-syscalls.sh`); the rest is the throughput rig.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip util-linux procps strace linux-perf \
    && rm -rf /var/lib/apt/lists/*

# bun (match host 1.3.14)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v1.3.14"

# deno (match host 2.9.4)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s v2.9.4 \
    && ln -sf /usr/local/bin/deno /usr/bin/deno

# oha (linux aarch64) - must match the host version the harness is written against: run.ts passes
# `--output-format json`, which older oha rejects, and a rejected flag reads as a 0 rps row.
RUN curl -fsSL -o /usr/local/bin/oha \
    https://github.com/hatoo/oha/releases/download/v1.14.0/oha-linux-arm64 \
    && chmod +x /usr/local/bin/oha

WORKDIR /repo
CMD ["bash"]
