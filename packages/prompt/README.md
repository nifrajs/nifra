# @nifrajs/prompt

Provider-neutral, type-safe prompts with Standard Schema input and validated structured output.

```sh
bun add @nifrajs/prompt
```

```ts
import { prompt } from "@nifrajs/prompt"
import { t } from "@nifrajs/schema"

const extract = prompt("Extract the contact from the text.")
  .input(t.object({ text: t.string() }))
  .output(t.object({ name: t.string(), email: t.string({ format: "email" }) }))

const contact = await extract.run({ text }, { complete: callYourProvider })
```

The package imports no vendor SDK. Supply a `complete` adapter for your provider; inputs are validated
before the call and model output is parsed and validated before it reaches application code. An optional
`heal` hook can repair and retry invalid structured output.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
