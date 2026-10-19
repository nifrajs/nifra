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

Store mode requires strongly consistent reads: every instance must observe completed writes and
deletes, including revocation markers. `createSessions` refuses adapters declaring
`consistency: "eventual"`. `KVSessionStore` declares this and is no longer accepted: Workers KV can
serve a cached session and a cached missing marker after logout, allowing renewal to restore it.
Its export remains available for reading and migrating legacy records.

Use a strongly consistent shared `SessionStore`, for example a transactional adapter or a Durable
Object, in production. `MemorySessionStore` remains suitable for development or an explicitly allowed
single-instance deployment. Custom adapters may declare `consistency: "strong"`; omitting the
declaration preserves compatibility but asserts the same strong-consistency contract. Wrapping or
relabeling Workers KV does not make its reads strongly consistent. No eventual-consistency opt-in is
provided, including when rolling renewal is disabled.

In store mode, `destroy` revokes the entire session family, including later IDs issued by
`regenerate`. A cookie that a rotation has already replaced does this only for 60 seconds after
the rotation, while the rotating response may still be on its way to the browser. After that,
logging out with it drops only that superseded ID, so a kept pre-login cookie cannot end the
session that replaced it. Rotated IDs remain opaque signed cookie values. Store adapters must retain
`<id>.rotated` and `<family>.revoked` marker records until their `expiresAt`, including after the
original session record is deleted. Do not interpret markers as sessions.
For store adapters, the family is the session's original ID: a rotated ID has the form
`<family>~<replacement>`, and repeated rotations keep that same family prefix.

Adapters may implement `SessionStore.rotate(previousId, nextId, record, marker)` atomically: refuse
when the previous record is missing, rotated, or its family is revoked; otherwise write the rotation
marker, delete the old record, and store the replacement in one transaction. Return whether it won.
The built-in memory store implements this operation. Adapters with only `get`/`set`/`delete` keep
logout markers separate from rotation markers and check family revocation after writing; concurrent
rotations can produce multiple replacement IDs, all revoked by one logout of the family.

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
