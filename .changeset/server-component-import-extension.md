---
"@nifrajs/web": patch
---

The coordinated server-component build accepts an import that names a `*.component.server.*` file with its extension, such as `./Summary.component.server.ts`; it replaces it with the component's reference, as it does an import without one. Such an import was refused as backend code.
