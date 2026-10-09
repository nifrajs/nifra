---
"@nifrajs/agent-protocol": minor
"@nifrajs/coding-agent": minor
"@nifrajs/agent-app": minor
---

Three events join the protocol: `reasoning.delta` (`turnId`, optional `itemId`, `text`), `plan.updated` (`turnId`, optional `callId` and `explanation`, and `entries` of `content` up to 4096 characters, `status` `pending` | `in_progress` | `completed`, optional `priority`; each event is the whole plan), and `context.usage` (`usedTokens`, optional `windowTokens`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `estimated`). The plan entry shape is ACP's. `NifraBackend`'s model port can stream `{ type: "reasoning_delta", text, itemId? }` and `{ type: "usage", usedTokens, ... }` chunks, which become those events; a count that is not a non-negative integer is dropped. `CodingAgentHost` keeps only counts as evidence (a plan's entry and completed counts, never its text), and `toEventView` projects them to `ReasoningDeltaView`, `PlanUpdatedView`, and `ContextUsageView` (with `fill` when the window is known). An exhaustive `switch` over `event.type` needs the three new cases.
