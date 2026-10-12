---
"@nifrajs/cli": patch
---

NF-D002 ignores an installed nifra package that neither the workspace nor an installed nifra package declares, such as a leftover `create-nifra`, and groups the installs it reports by version and location (`5 packages at 4.0.2 under <dir> (@nifrajs/cli, @nifrajs/client, @nifrajs/core and 2 more)`) instead of listing every package on one line.
