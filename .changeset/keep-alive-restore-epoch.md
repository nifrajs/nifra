---
"@nifrajs/web": patch
---

A page Back restores from keep-alive is kept again only under the visitor it was restored for. Before,
when the epoch cookie changed while the restored page's reload was in flight (a sign-in or sign-out
in another tab whose signal had not reached this one yet), the page took the new epoch: leaving it
kept the previous visitor's data, from the late reload or from the kept response a failed reload
falls back to, and Back showed it to the new visitor.
