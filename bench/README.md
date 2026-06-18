# Benchmarks

The benchmark **code** lives here; the **results** are not committed. Absolute req/s moves with
machine load (thermal state, other processes), so numbers are only meaningful as same-run ratios on
your own idle machine — a committed snapshot would just be misleading. Run them yourself:

```sh
# HTTP throughput (driven by `oha` — install: https://github.com/hatoo/oha)
bun run bench:http              # full matrix: Bun + Node + Deno
bun run bench:http bun          # one runtime section (bun | node | deno)
bun run bench:http:quick        # fast comparative smoke (~30s): nifra vs the field, ranked
bun run bench:http:quick bun    # …on the Bun section (adds Elysia)
bun run bench:http:quick deno post   # …Deno, POST /users workload
bun run bench:http:update       # repeated matrix, medianed, writes BENCHMARKS.md (git-ignored, local)
bun run bench:http:update --full     # all 4 workloads instead of the default GET + POST pair

# Other axes
bun run bench:ssr               # SSR throughput per UI runtime
bun run bench:size              # server bundle size
bun run bench:coldboot          # cold-start time
```

`bench:http:update` writes a local `BENCHMARKS.md` at the repo root (git-ignored). Read the
same-run ratios (nifra vs the field, % of the raw server) — not the absolute numbers.

Workloads are identical across every framework (`bench/http/serve*.ts`): `GET /users/:id` (routing +
path param) and `POST /users` (validated body), plus `GET /` and `GET /search` under `--full`. Each
server runs in its own subprocess, measured one at a time, so nothing contends with the load client.
