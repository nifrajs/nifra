---
"@nifrajs/web": patch
---

A dynamic boundary whose data is still streaming now reports `status: "pending"` in the document handover and in a client navigation's data, instead of `"unresolved"`, and a dynamic boundary with no loader reports `"ready"`. Static boundaries keep their own state, and intercept boundaries stay `"unresolved"` until a target fills them.

A client that leaves while a deferred value or a dynamic boundary is still loading no longer logs `[nifra/web] deferred value rejected` or `[nifra/web] boundary load failed` for a load that gave up on the request's abort. A real failure is still logged.
