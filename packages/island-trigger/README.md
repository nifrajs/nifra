# @nifrajs/island-trigger

Framework-neutral, browser-side trigger scheduling for Nifra’s island runtime,
`@nifrajs/web/islands`.

It has no DOM or UI-framework dependency. The public contract is the small `scheduleTrigger`
primitive with these strategies:

```ts
import { scheduleTrigger } from "@nifrajs/island-trigger"

const dispose = scheduleTrigger({ media: "(min-width: 768px)" }, () => {
  // Activate the island.
})

dispose() // cancel before the trigger fires
```

`load`, `idle`, `visible`, and media-query triggers are one-shot. Idle and visibility strategies
fall back safely when the browser capability is unavailable; malformed or oversized media queries
remain inert. The package only schedules the callback - each island runtime owns its own markers,
registry, signals, and framework integration.

For AI agents, see [`LLM.md`](./LLM.md). The wider reference is in
[`llms-full.txt`](../../llms-full.txt).
