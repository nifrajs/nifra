---
"@nifrajs/cli": minor
---

`nifra check` reports NF-S010 for a Deno or Bun listener that answers requests without checking `Host`, when the listener terminates TLS itself or `nifra.check.json` declares `"hostTopology": "direct"`. `"hostTopology": "proxied"` silences it, as does `validateHost`, `allowedHosts` or `canonicalHost` set anywhere in the project, or a `nifra-expect NF-S010: <reason>` comment above the listener. The rule is a warning and never infers a proxy from deployment files.
