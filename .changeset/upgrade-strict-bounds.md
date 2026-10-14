---
"@nifrajs/cli": patch
---

`nifra upgrade` no longer writes a range that excludes the version it upgrades to. A strict bound kept its operator, so a peer `"<5.2.0"` became `"<5.3.0"` and a dependency `">5.2.0"` became `">5.3.0"`, both still refusing 5.3.0; they now become `"<=5.3.0"` and `">=5.3.0"`. An upper bound that already admits the target, such as `"<6.0.0"`, is left as written in every field; it was rewritten to `"<5.3.0"` and refused as a rollback, which blocked the whole upgrade.
