---
"@nifrajs/web": minor
"@nifrajs/cli": minor
"create-nifra": minor
---

`export const clientIp = "platform"` in `nifra.config.ts` makes a `cloudflare` or `vercel` build read `c.clientIp` from the header that platform's edge overwrites (`cf-connecting-ip`, `x-real-ip`), so per-caller middleware such as `rateLimit` works there. Without it an edge build still has no caller address; Bun, Node and Deno builds use the socket peer either way. `buildTarget` and `generateServerEntry` take the same `clientIp` option. Site scaffolds declare it.
