---
"@nifrajs/core": patch
---

The router's cache of matched dynamic paths bounds the total length of the paths it holds (256 Ki characters) as well as their count. 2048 paths of 8 KB each used to stay resident as 16 MiB; they now hold under 1 MiB on Bun, Node and Deno, with lookups at the same speed.
