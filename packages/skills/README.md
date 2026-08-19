# @nifrajs/skills

Portable agent skills for [Nifra](../../README.md) - one `SKILL.md` bundle, published to every agent
surface that reads a `skills/` directory.

A skill is loaded on demand: the agent sees only each skill's name and description until it decides
one applies, then reads the body. That keeps Nifra's conventions out of the context window until they
matter.

```
skills/
  nifra/SKILL.md         entry point - MCP-first rule, the core loop, the non-negotiables
  nifra-api/SKILL.md     typed routes, schemas, middleware, WebSockets, the never-throwing client
  nifra-web/SKILL.md     file routing, loaders/actions, SSR, islands, the client/server boundary
  nifra-verify/SKILL.md  check, assure, capabilities, manifest diff, the verification ladder
```

## Install

**Pi**

```sh
pi install npm:@nifrajs/skills
```

**Claude Code**

```sh
/plugin marketplace add nifrajs/nifra
/plugin install nifra@nifra
```

The plugin registers the Nifra MCP server as well as the skills, so a fresh install has the live tools
the skills tell it to prefer. Its launch spec is deliberately unpinned - a plugin is installed once and
opened against many projects, so the CLI resolves per project and the server reports version skew
itself rather than freezing one version across all of them.

**Anything that reads a skills directory** (Cursor, `.agents/skills`, a project `.pi/skills`)

```sh
bun add -d @nifrajs/skills
cp -R node_modules/@nifrajs/skills/skills/* .agents/skills/
```

## These skills are deliberately thin

They teach shape and rules, not signatures. Signatures come from the MCP server, which is typechecked
against the version installed in the project being edited:

```sh
bunx @nifrajs/cli init-agents      # register the MCP server in an existing app
```

The Claude Code plugin brings its own copy of that server, so `init-agents` is for the other surfaces -
and for committing a version-pinned `.mcp.json` that every contributor on the project shares.

Not in a Nifra project? The docs tools are hosted at `https://mcp.nifra.dev`.

That split is the anti-drift design: a skill that restated the API would rot on the next release,
while a skill that says "ask `nifra_types`" stays correct. Keep it that way when editing these files -
if you find yourself pasting a signature in, reach for a tool reference instead.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card, one cheap read instead of the whole
corpus. For the wider framework: the repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste quick
reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.

MIT licensed.
