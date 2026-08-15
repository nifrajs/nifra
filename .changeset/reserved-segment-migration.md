---
"@nifrajs/client": minor
"@nifrajs/cli": minor
---

The reserved typed-client proxy keys are now a frozen, published contract with a migration path.

`nifra fix --code NF-C018` rewrites the call sites a reserved-named route segment breaks. It reads the sites from the compiler rather than from a text search, so it finds every one and never mistakes a real `.delete` verb call for a path segment; a site it cannot rewrite confidently (bracket access, a node held in a variable) is reported and left alone rather than guessed at.

`nifra routes` now annotates a colliding route with the reserved key and the spelling that reaches it, in both the table and `--json`, so the closed set is visible while the route is being written instead of when a build breaks. The typed-client call form printed by `nifra context` and the `nifra_routes` MCP tool is corrected for these routes too: a reserved segment is emitted as a call on the parent node, never as a property or bracket access, both of which the proxy intercepts.

`@nifrajs/client` exports the set itself - `RESERVED_VERB_KEYS`, `RESERVED_EXACT_KEYS`, `RESERVED_KEY_READOUT`, and `reservedKeyFor(segment)` - as the one place it is written down. The list is frozen: no name is ever added to it, because adding one breaks, at compile time, every consumer that happens to have a route segment with that name. Anything the client gains from here on is reached through a namespaced or symbol key, which no URL path segment can spell.

Client 2.12.0 should have been a major release: its reserved-segment types reject a property access that compiled in 2.11. Its changelog entry now says so, and `CONTRIBUTING.md` states the rule - a type that stops compiling is a breaking change, runtime behavior notwithstanding, and ships with a codemod.
