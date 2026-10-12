---
"@nifrajs/core": patch
"@nifrajs/web": patch
---

The single-copy resolver and the build's duplicate-copy scan treat a `file:` dependency Bun installs as a folder of linked files the way they treat a linked package. Before, only a symlinked package directory counted, so the second React that such a package's own `node_modules` held went unredirected and unreported by `nifra check`.
