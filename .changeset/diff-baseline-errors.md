---
"@nifrajs/cli": patch
---

`nifra diff` with a missing baseline says where it looked and to create it with `nifra snapshot`, instead of a raw file error. Its text output lists each change with its severity, breaking first, and a summary line; the `--json` shape is unchanged. `nifra snapshot` and `nifra diff` on an app still on the retired root layout name `nifra migrate layout`. The contract proof reports a baseline outside the project as `the baseline <path> is outside the project directory`, a symlink that leaves it included.
