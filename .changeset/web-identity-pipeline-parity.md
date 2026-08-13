---
"@nifrajs/web": minor
---

Fail a build or dev-server start when identity-sensitive packages (the framework runtime, React,
Preact, Svelte, Solid, Vue) resolve to more than one physical copy, or when the development and
production manifests diverge in routes, public files, or styles. Single-file-component `<style>`
blocks count as styles, so a scoped-style Svelte or Vue component is not reported as diverging from a
production manifest that carries its extracted stylesheet.
