---
"@nifrajs/cli": minor
---

`nifra doctor` (and `nifra check`, as `NF-D002`) counts the nifra a `link:` or `file:` repository outside the workspace installs in its own `node_modules`. That repository loads its own copy whatever the workspace installs, so two live-linked repositories that each pin one version, at different versions, are now reported as mixed versions.

`nifra upgrade` and `--list` mark a release that announces no behaviour change for the packages a project loads: a release recipe may name the packages its notes change (`affects`), and a project that loads none of them sees that beside the release. 5.4.0 names `@nifrajs/node`, `@nifrajs/web` and `@nifrajs/cli`.
