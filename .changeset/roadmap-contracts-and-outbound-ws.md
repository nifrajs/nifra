---
"@nifrajs/core": patch
"@nifrajs/content": patch
"@nifrajs/island-trigger": patch
"@nifrajs/islets": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-react": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
default remains type-level only.
