---
"@nifrajs/a2a": minor
"@nifrajs/ag-ui": minor
---

New agent protocol adapter packages. `@nifrajs/a2a` mounts a nifra agent as an Agent2Agent (A2A) 1.0 server: the agent card on GET, the JSON-RPC binding on POST with `SendMessage`, `SendStreamingMessage` (step evidence over SSE), and `GetTask`, plus human-in-the-loop resume through message metadata. `@nifrajs/ag-ui` mounts the same agent as an AG-UI endpoint: `RunAgentInput` in, the AG-UI event stream out - run lifecycle, tool-call and step events, text message events for the output, and a typed continuation for resume. Both are protocol bridges over `@nifrajs/agent` - the request body goes through core's bounded, prototype-guarded framing lane, and the model, state store, and approval transport are injected per request.
