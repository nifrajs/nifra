---
"@nifrajs/cli": patch
---

`nifra upgrade` leaves a `peerDependencies` range alone when it already admits the target, and raises one that excludes it keeping its operator, even with `--exact`: a library's `">=3.1.0"` floor stays put instead of becoming `">=5.2.0"`. A peer range no longer sets the version an upgrade starts from either: that comes from the lowest version a dependency, devDependency or override pins, then the lowest installed, and a peer floor only when nothing else names one, so a library workspace whose devDependencies are already on the target's major no longer replays the recipes of the releases its peer floor names. `nifra check` (NF-D002) and `nifra doctor` no longer count a peer floor as a second version of nifra in the workspace.
