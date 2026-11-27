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

`load`, `idle`, `visible`, `interaction`, and media-query triggers are one-shot. Idle and visibility
strategies fall back safely when the browser capability is unavailable; malformed or oversized media
queries remain inert. `interaction` waits for the first `pointerover`, `pointerdown`, `focusin` or
`click` on the `target`. A click mounts during capture on the host. Listeners attached during mount
can receive it at a descendant target or in the host's non-capture phase. Capture listeners added to
the host during mount start with the next click. The callback runs at once when the target cannot take
listeners. Each island runtime owns its own markers,
registry, signals, and framework integration.

For AI agents, see [`LLM.md`](./LLM.md). The wider reference is in
[`llms-full.txt`](../../llms-full.txt).
