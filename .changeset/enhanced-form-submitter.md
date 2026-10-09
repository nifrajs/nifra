---
"@nifrajs/web": patch
---

Enhanced forms no longer run an action twice, and they submit through the button that was pressed. A data submit answered with a non-2xx status fell back to posting the form natively, which ran the action a second time; any answer from the server now loads the page instead, and the rejection from `router.submit` names that page in `redirectTo` with the failure as its `cause`. The pressed button's `name`/`value` is now part of the body, its `formaction`, `formmethod` and `formtarget` apply, and a form or button that targets another browsing context posts natively. The native fallback, used only when nothing reached the server, goes through the same button.
