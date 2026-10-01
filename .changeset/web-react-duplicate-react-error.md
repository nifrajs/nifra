---
"@nifrajs/web-react": patch
---

fix(web-react): a render that hits two copies of React says so. When a component's hooks come from a
different React than the one `react-dom/server` renders with (often a linked package's own
`node_modules`), SSR failed with the engine's raw null-dispatcher `TypeError`. It now fails with
`[nifra/web-react] a component called a React hook with no dispatcher`, naming the duplicate and the
fix, with the original error kept as `cause`.
