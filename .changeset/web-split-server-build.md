---
"@nifrajs/web": patch
---

`buildTargetWith` refuses a server build that emitted code chunks besides its entry, naming them, because every server target's deploy ships the entry file alone. A split server used to build and then fail at its first import of a chunk.
