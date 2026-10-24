---
"@nifrajs/web": patch
---

The Vite dev server hands the app a field sent more than once, whose last value is empty, as
production does: `x-caller: a` then `x-caller:` is `"a, "` (and `cookie` is `"a=1; "`), where dev
read `"a,"`.
