---
"@nifrajs/agent": minor
---

Add `mountAgent` (`@nifrajs/agent/mount`) - a one-call HTTP seam that exposes an agent definition as `POST /agent`, reading the request body through core's bounded, proto-guarded framing lane and driving the bounded runner. It negotiates a Server-Sent Events evidence stream on `Accept: text/event-stream` (one `step` event per evidence item, then a final `result`) and returns the projected run result as JSON otherwise. Ports - model, state store, approval transport, capabilities, budgets - are supplied per request through a factory, so the seam performs no I/O of its own and carries no credentials or durable state.
