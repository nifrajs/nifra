---
"@nifrajs/cli": minor
---

`nifra upgrade --from <version>` names the version to upgrade from. Without it the starting version is the lowest one a `package.json` pins, so a workspace whose pins were bumped by hand has no recipe left to apply; with it, the recipes after that version apply. An option or extra argument `nifra upgrade` does not know is refused instead of ignored, and `nifra upgrade --help` prints the usage. The `servePublicDir` rewrite writes the quote style of the file it edits.
