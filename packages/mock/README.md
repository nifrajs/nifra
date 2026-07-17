# @nifrajs/mock

Generate deterministic mock responses from a Nifra application's reflected response contracts.

```sh
bun add -d @nifrajs/mock
```

```ts
import { createMockServer } from "@nifrajs/mock"
import { app } from "./app"

const mock = createMockServer(app, { seed: 42 })
const response = await mock.fetch(new Request("http://local.test/users/1"))
```

The mock server matches reflected routes and synthesizes values from supported JSON Schema keywords.
Unsupported or unsatisfiable schemas fail explicitly instead of returning known-invalid data. Use a
fixed seed when responses must be replayable across local development and CI.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
