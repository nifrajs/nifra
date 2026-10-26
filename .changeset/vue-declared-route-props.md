---
"@nifrajs/web-vue": patch
---

A Vue page, layout or `_error` boundary receives only the route props it declares, in its own `props` or through `extends` and `mixins`. A route prop it does not declare no longer becomes an attribute on its root element once the client renders it, such as `layoutdata="[object Object]"` or `pending="true"`, and a component with a fragment root no longer warns about it in development. A functional component that declares no props still receives every route prop, and an async component passes every route prop to the component it loads.
