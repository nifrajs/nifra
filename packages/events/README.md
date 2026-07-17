# @nifrajs/events

Portable, versioned event contracts — a typed, transport-agnostic event envelope validated by any Standard Schema.

An envelope may carry the bounded `@nifrajs/core/causality` context for its exact event id. Creation
and parsing reject mismatched nodes and unknown fields, so arbitrary payloads cannot hitchhike in the
lineage metadata.

See the [nifra docs](https://github.com/nifrajs/nifra#readme).

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
