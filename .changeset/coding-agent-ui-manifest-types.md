---
"@nifrajs/coding-agent": patch
---

`UiExtensionHost` now type-checks every manifest field, so an array id, an object label, a string theme or an unknown slot or density rolls the reload back. The active graph holds only the documented manifest fields; extra keys are dropped.
