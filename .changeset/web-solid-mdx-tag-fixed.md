---
"@nifrajs/web-solid": patch
---

The MDX runtime's intrinsic components always render their own tag: a `component` prop on a Markdown element no longer replaces the element, and the element's props stay reactive. `useMDXComponents()` now types each component's result as `JSX.Element` instead of `unknown`.
