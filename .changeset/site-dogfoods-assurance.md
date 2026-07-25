---
"@nifrajs/cli": patch
---

The documentation site now holds the bar it sells: `nifra.assurance.ts` plus a capability lockfile, at
L2.

It is also the first validation of the capability model on an app nobody designed around it. Two things
that only a real app can answer:

- **No false positives.** 47 route files carry dozens of documentation samples containing
  `import { Database } from "bun:sqlite"` and friends inside template literals. None became capability
  evidence, because the scanner blanks template contents before reading imports.
- **Real imports are still caught.** Adding one genuine `bun:sqlite` import to the backend immediately
  flagged all four routes, including the GET dead end with its structural message.
