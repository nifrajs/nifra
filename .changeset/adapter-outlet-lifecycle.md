---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
---

The React and Preact `ServerComponent` outlets mount, adopt and tear down their instance through one lifecycle in `@nifrajs/web/internal/component-outlet`, and behave alike. An outlet whose host holds no `<nifra-component>` reports `component_contract` through `onError` rather than returning silently in React or throwing in Preact. A mount, adoption or teardown failure reaches both the controller a page passes and the outlet's own `onError`. A React outlet adopts new component state only when that state changes, not when its `onError` does.
