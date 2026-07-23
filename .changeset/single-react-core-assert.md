---
"@nifrajs/web-react": patch
---

Catch a duplicate React reaching SSR with both paths, instead of a null-dispatcher crash.

The adapter already re-roots `react-dom/server` to the app so it shares the route components' React. That
fixes the common case but cannot guarantee the last mile: a `react` nested under react-dom, or a
components tree resolving `react` elsewhere, still puts two React cores in the render. Two cores is two
hook dispatchers, and SSR throws `resolveDispatcher().useState is null` from deep inside react-dom-server
- a message that names a React internal and nothing about the two directories that caused it, from which
the real fix is hours of inference.

After re-rooting, the adapter now compares the realpath of the `react` react-dom will render with against
the `react` the components import, and if they differ throws naming both paths and the fix. `nifra doctor`
checks what is installed; this checks what SSR actually resolved, which is the only thing that can catch a
duplicate the two dev pipelines introduce (Bun resolves SSR, Vite the client) rather than the install - a
Vite `resolve.dedupe` or alias fixes only the client bundle, never this path. Silent on the single-copy
common case, and it never manufactures a failure: a `react` it cannot resolve on either side is not
evidence of a duplicate. Runs once, under the unbundled Bun runtime only, so bundled and non-Bun outputs
are untouched.
