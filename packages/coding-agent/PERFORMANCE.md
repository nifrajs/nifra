# Agent performance evidence

Run the reproducible local measurements with:

```sh
bun run bench:agent -- --events=100000 --json
bun run bench:agent:reload -- --runs=20 --json
bun run bench:pi -- --turns=1000 --json
bun run demo:agent-extension
```

The bounded event stream and context window stay constant-size under event growth. The Pi adapter
benchmark compares the same no-model JSONL process against the protocol adapter; the result is
machine-load sensitive, so record the full JSON output and hardware when publishing a comparison.

Agent Platform checks additionally keep plan compilation, evidence projection, recovery schedules,
gateway retries, and Workbench replay views payload-free. The Workbench reference check uses 2,000
evidence rows, a 100-row visible window, and a 256-node graph; it enforces the recorded projection
and render budgets without serializing content.
