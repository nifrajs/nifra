# @nifrajs/acp

An `AgentBackend` for agents that speak the [Agent Client Protocol](https://agentclientprotocol.com)
(version 1) over stdio: Claude Code through `claude-code-acp`, Codex through `codex-acp`, Gemini CLI
with `--experimental-acp`, or any other ACP agent. A Nifra host, RPC server, or app drives it like any
other backend.

```ts
import { AcpBackend } from "@nifrajs/acp"
import { CodingAgentHost } from "@nifrajs/coding-agent"

const backend = new AcpBackend({
  command: "claude-code-acp",
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
})
const host = new CodingAgentHost({ backend })
```

Each session is one agent process: `initialize` (protocol version 1, refused otherwise), an optional
`authenticate` with `authMethod`, then `session/new` in the session's absolute `cwd`. A message is a
`session/prompt`; its updates become protocol events:

| ACP update | Event |
| --- | --- |
| `agent_message_chunk` | `assistant.delta`, and the whole reply as `assistant.message` before a tool call and at the end |
| `agent_thought_chunk` | `reasoning.delta` |
| `tool_call`, `tool_call_update` | `tool.started`, then `tool.completed` once the status is `completed` or `failed` |
| `plan` | `plan.updated` |
| `usage_update` | `context.usage` (`used`, `size`) |
| anything else | `x-acp.<sessionUpdate>` with a bounded copy of the update |

The stop reason ends the turn: `end_turn`, `max_tokens`, and `max_turn_requests` complete it (any but
`end_turn` also reported as `x-acp.stop_reason`), `refusal` fails it, and `cancelled` stops it.

`session/request_permission` surfaces as `approval.required` (`capability` is `acp.<tool kind>`).
`resolveApproval` answers with the agent's `allow_once` or `reject_once` option and never an "always"
one, so the host's approval policy stays in charge; with no such option it answers `cancelled`. An
approval the agent withdraws with `$/cancel_request` is answered and reported as `approval.resolved`
with `approved: false`.

The client offers no filesystem or terminal methods: the agent uses its own tools, and those
requests get JSON-RPC `-32601`. `cancel` answers open approvals `cancelled` and sends
`session/cancel`; an agent that has not ended the turn after `cancelGraceMs` (default 2 seconds) is
stopped, which ends its session.

The agent runs with `PATH`, `HOME`, locale, terminal, user, shell, and temp variables plus what `env`
adds; nothing else from the parent environment passes, so give it its model credentials explicitly.
Error text from the agent (a refused request, or the last error-looking stderr line when it exits)
is cut to a bounded length with those values and common key shapes masked. stdout carries only
JSON-RPC, one message per line, each at most `maxRecordBytes` (default 1 MiB).

The package passes `@nifrajs/agent-protocol/conformance` against a scripted ACP agent.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
