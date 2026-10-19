---
"@nifrajs/cli": minor
---

`nifra check` reports an identity-sensitive package installed at more than one version as NF-C046, an error, instead of NF-C009. NF-C009 now covers only copies of one version, the duplicates a `singleCopy` declaration collapses, so a severity override on NF-C009 no longer changes how a version skew is reported. Its fix names the one version to install (`nifra upgrade <version>` in each install root for nifra's own packages) and no longer suggests a `singleCopy` declaration, which never covers a skew.

`nifra upgrade` finds a linked package that loads another nifra version when its workspace hoists nifra to the workspace root, and through the workspace packages it depends on. It resolves each package from the linked package's real path, walking up through every `node_modules` as Node and Bun do, instead of reading only the linked package's own folder, and prints one upgrade command per install root.

NF-D003 compares a `file:` package's `devDependencies` with what bun.lock recorded. Bun installs a `file:` package's devDependencies and never refreshes them, so a stale entry there installed an old version unreported.

`nifra doctor`'s production-readiness table reads the source of `file:`, `link:` and workspace packages the app imports, and of those they import, so a setting a shared server factory applies counts as configured. The evidence names the package it came from. Registry installs and nifra's own packages are not read.

NF-S002 no longer reports a comparison between two `const`s initialized from configuration reads (`const a = process.env.A_KEY`), such as a startup check that two keys differ. It reports names ending in `serviceKey`, `privateKey`, `signingKey`, `masterKey` and `encryptionKey` as secrets, which it missed before.
