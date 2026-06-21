# @nifrajs/cron

Runtime-agnostic **in-process cron** for long-running nifra servers (Bun / Node / Deno). Standard
5-field expressions + `@macros`, overlap-safe, error-isolated, graceful stop. Dependency-free.

```ts
import { createScheduler } from "@nifrajs/cron"

const cron = createScheduler({
  onError: (err, name) => logger.error("cron job failed", { name, err }),
})
  .add("nightly-digest", "0 2 * * *", () => sendDigest())
  .add("poll-feed", "*/5 * * * *", async () => { await pollFeed() })
  .add("weekly-cleanup", "@weekly", () => cleanup())

cron.start()           // checks every 15s; fires each job once per matching minute
// on shutdown:
cron.stop()            // graceful — in-flight handlers finish
```

## Expressions

`minute hour day-of-month month day-of-week`, **local time**. Each field:

| syntax | meaning |
| --- | --- |
| `*` | every value |
| `5` | exactly 5 |
| `1-5` | range |
| `*/15` | every 15th (step) |
| `0-30/10` | range with step → 0,10,20,30 |
| `1,3,5` | list |

Macros: `@hourly` `@daily` (`@midnight`) `@weekly` `@monthly` `@yearly` (`@annually`).

Day-of-month + day-of-week follow the **standard OR rule**: when both are restricted, a match on
either fires the job.

## Guarantees

- **Overlap-safe** — a job still running when its next minute arrives is *skipped*, not stacked.
- **Error-isolated** — a handler that throws or rejects goes to `onError` (default `console.error`);
  it never tears down the scheduler loop.
- **Graceful stop** — `stop()` clears the timer; in-flight handlers run to completion.
- **Loud at registration** — a bad expression or a duplicate job name throws at `add()`, not at fire.
- **Doesn't pin the process** — the interval is `unref`'d, so the scheduler alone won't keep a
  process alive.

## Testing

`tick(date)` runs every job due at a given instant with no real timers — drive it with controlled
dates to test schedules deterministically. `runNow(name)` fires a job off-schedule (e.g. an admin
"run now" button). The pure core — `parseCron(expr)`, `matches(fields, date)`, `nextRun(fields, from)`
— is exported too.

## Cloudflare Workers

Workers has no long-lived process, so in-process cron doesn't apply. Use the platform `scheduled`
trigger instead: `toFetchHandler(app, { scheduled })` from `@nifrajs/core` + a `[triggers]` cron in
`wrangler.toml`. This package is for Bun/Node/Deno servers.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
