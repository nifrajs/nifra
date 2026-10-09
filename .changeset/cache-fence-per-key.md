---
"@nifrajs/cache": patch
---

`MemoryCache` fences now compare only the changes that matter to a load: the key itself, its tags and `clear()`. The fence used to look back over the last 1024 changes of any kind, so under steady write traffic a slow load of a hot key was refused its write every time and the key never cached. Up to 65,536 distinct keys and tags are remembered; a fence older than a forgotten change is still refused.
