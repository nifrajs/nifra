---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

The React, Preact, Solid, Svelte and Vue `useServerFn` bindings take their function through one shared helper in `@nifrajs/web/internal/client-server-fn`.

The React, Svelte and Vue client and keep-alive mounts read a hydration verification runner's hooks through one reader in `@nifrajs/web/internal/hydration-assurance`. Recoverable errors and warnings reach the runner as before.
