# @nifrajs/auth

Session primitives for nifra - signed-cookie + server-store sessions, CSRF, and route guards. Bring your own identity (Better Auth / Lucia / OAuth); nifra owns the session.

`Authorizer`/`requireAuthorization` provide a small public policy seam. The application or data layer
must decide ownership and permissions; Nifra stores no policy, tenant, or subject data.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/auth
```

## Store revocation and rotation

In store mode, `destroy` revokes the entire session family, including later IDs issued by
`regenerate`. Rotated IDs remain opaque signed cookie values. Store adapters must retain
`<id>.rotated` and `<family>.revoked` marker records until their `expiresAt`, including after the
original session record is deleted. Do not interpret markers as sessions.
For store adapters, the family is the session's original ID: a rotated ID has the form
`<family>~<replacement>`, and repeated rotations keep that same family prefix.

Adapters may implement `SessionStore.rotate(previousId, nextId, record, marker)` atomically: refuse
when the previous record is missing, rotated, or its family is revoked; otherwise write the rotation
marker, delete the old record, and store the replacement in one transaction. Return whether it won.
The built-in memory store implements this operation. Adapters with only `get`/`set`/`delete` keep
logout markers separate from rotation markers and check family revocation after writing; concurrent
rotations can produce multiple replacement IDs, all revoked by logout of any family member.

## Docs

- Reference: <https://nifra.dev/docs>
- AI-readable: <https://nifra.dev/llms.txt>

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
