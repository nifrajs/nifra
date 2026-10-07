---
"@nifrajs/agent-protocol": minor
---

feat(agent-protocol): `splitAgentText`, `boundAgentText`, and `boundAgentValue` keep a backend's events inside the protocol's bounds, with `AGENT_MAX_EVENT_TEXT` (256 KiB) and `AGENT_MAX_PAYLOAD_STRING` (64 KiB) naming them. `splitAgentText` turns a long reply into consecutive pieces that each fit an event and join back to the text; `boundAgentText` cuts one field with a marker; `boundAgentValue` makes a display copy of a tool's input or output (strings cut with a marker, arrays, keys, depth, and nodes kept within the limits, a `__proto__` key kept as an own entry). All three replace NUL, which `isAgentEvent` refuses, with U+FFFD and never cut between the halves of a surrogate pair.
