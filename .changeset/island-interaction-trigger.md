---
"@nifrajs/island-trigger": minor
"@nifrajs/web": minor
---

Islands take a new `interaction` strategy: `data-island-strategy="interaction"` (or `strategy="interaction"` on the React `<Island>`) mounts the enhancer on the first hover, press, focus or click on the host. The first three arrive before the click they lead to, and a click mounts the island before it reaches its target, so the enhancer receives that same click (assistive technology can activate a control with no earlier pointer or focus event). A host that cannot take listeners mounts at once. The base island runtime grows by about 79 B gzipped.

In development, a `data-bind-text` or `data-bind-show` whose server-rendered value differs from the signal's first value now logs one console warning, since the page would change on mount. It sits behind `process.env.NODE_ENV`, so a production build that defines it carries no extra bytes.
