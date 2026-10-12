---
"@nifrajs/cli": patch
---

`nifra migrate layout` keeps the `/api` mount 3.x and 4.x made by default: moving a root `backend.ts` adds `export const apiPrefix = "/api"` to the framework config unless one is set. A folder whose imported files all go to one zone now moves whole, so files nothing imports yet stay beside their folder instead of being left behind; a file using `node:` or `bun:` never follows its folder into `frontend/` or `shared/`, and a nested package stops the move. A missing output schema on a backend half the run did not write is listed under `next` (`followUps` with `--json`) with the `nifra schemas --write` command and no longer makes the command exit `1`.
