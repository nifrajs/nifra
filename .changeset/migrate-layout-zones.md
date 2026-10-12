---
"@nifrajs/cli": minor
---

`nifra migrate layout --zones` keeps every module the layout would move into `frontend/`, `backend/` or `shared/` where it is and lists it in the app's `"nifra": { "zones": ... }` instead: the widest folder whose files all belong to one side, or the file itself where its folder holds both. A data file a zone imports is listed the same way instead of being reported. Route files are still split, the root `backend.ts` and `framework.ts` still move, and a second run lists nothing new.
