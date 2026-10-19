---
"@nifrajs/core": patch
"@nifrajs/node": patch
"@nifrajs/web": patch
---

Static files answer a `HEAD`, and a `304` for the tag remembered for the file's settled version, from the file's stat without reading it. For files up to 256 KiB these run 1.22-1.59x faster on the Node reader, 1.24-1.89x on `servePublicDir()` under Bun, and 1.11-1.57x on the Deno entry. A snapshot over 4 KiB is now proven unchanged by a restat instead of hashed again, so an 8-24 KiB file serves 1.02-1.15x faster on Node and Bun; the Deno entry keeps 24 KiB, where a stat costs more. `contentTags()` takes the cut as `rehashMax`.
