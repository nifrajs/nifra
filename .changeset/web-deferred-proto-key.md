---
"@nifrajs/web": patch
---

Deferred-data reconstruction stores every key with `Object.defineProperty`, on the server walk and in
the injected client mapper alike. A `__proto__` key in serialized data previously went through plain
assignment, which walks the inherited setter instead of storing data - so the key silently vanished
from the reconstructed object, and on the client it reached a prototype setter with attacker-shaped
data. The result is still a plain `{}` with `Object.prototype` intact, so `toString`, `hasOwnProperty`
and `constructor` keep working on the value the app receives.
