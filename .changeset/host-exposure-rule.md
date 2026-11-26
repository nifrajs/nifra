---
"@nifrajs/cli": minor
---

`nifra check` reports NF-S010 for a Deno or Bun listener that answers requests without checking `Host`, when the listener call shows it terminates TLS itself (options built elsewhere are not traced) or `nifra.check.json` declares `"hostTopology": "direct"`. `"hostTopology": "proxied"` silences it, as does `validateHost` set anywhere in the project (the Node adapters' `allowedHosts` and `canonicalHost` do nothing on a Deno or Bun listener), or a `nifra-expect NF-S010: <reason>` comment above the listener. The rule is a warning and never infers a proxy from deployment files.
