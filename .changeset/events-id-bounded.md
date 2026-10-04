---
"@nifrajs/events": patch
---

An event envelope id is 1 to 128 characters, the same bound a causal node id has. `parse()` reports a longer id as an issue on `id`, and `create()` throws a `TypeError` for an empty or longer `id` option instead of building an envelope its own contract would refuse.
