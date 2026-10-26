---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

Every binding's `useNavigate` returns one navigate from `@nifrajs/web/internal/navigate-runtime`, the same function on every call. The React, Preact, Solid and Vue `Hole` components read their boundary state through the `HoleState` type in `@nifrajs/web/internal/hole-runtime`.
