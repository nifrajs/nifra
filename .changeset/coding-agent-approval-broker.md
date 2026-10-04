---
"@nifrajs/coding-agent": minor
---

`ApprovalManager` and the handoff approval mirror:

- An approval opened with a `coordinate` is approved only through `resolveMatched()`. `resolve(id, true)` returns `undefined` and leaves it pending; `resolve(id, false)` still denies it.
- `HandoffCoordinator` gives the approval it pairs with a handoff that handoff's coordinate, and settles it through `resolveMatched()` with its own clock. An untyped approve over RPC no longer settles the approval while the handoff stays open.
- `request()` resolves with a decision made while `onRequired` is still running. Previously that decision was broadcast but the waiter resolved `false`.
- `offer()` and `request()` for an id that is already pending return `undefined` and `false`, and the pending approval is unchanged. Previously the second call replaced the first, which then never settled.
- Approval and session ids accept the agent protocol's full token alphabet, including `/`. `observe()` cuts an action label longer than 512 characters instead of throwing, so a protocol-valid `approval.required` event no longer ends the turn.
- A rejected `onResolved` promise, or an `onRequired` failure behind a handoff's approval, no longer surfaces as an unhandled rejection.
- `HandoffCoordinator.open()` refuses a `sessionId` outside the token alphabet with `invalid_handoff`.
