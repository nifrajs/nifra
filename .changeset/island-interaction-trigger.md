---
"@nifrajs/island-trigger": minor
"@nifrajs/web": minor
---

Use `data-island-strategy="interaction"` or `strategy="interaction"` on the React `<Island>` to mount the enhancer on the first hover, press, focus or click on the host. A click mounts during capture on the host, including activation by assistive technology without an earlier pointer or focus event. Listeners attached during mount can receive that click at a descendant target or in the host's non-capture phase. Capture listeners added to the host during mount start with the next click. A host that cannot take listeners mounts at once. The base island runtime grows by about 79 B gzipped.

In development, a `data-bind-text` or `data-bind-show` whose server-rendered value differs from the signal's first value now logs one console warning, since the page would change on mount. It sits behind `process.env.NODE_ENV`, so a production build that defines it carries no extra bytes.
