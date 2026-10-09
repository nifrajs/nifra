---
"@nifrajs/core": major
"@nifrajs/web": major
---

An order-scoped hook (`derive`, `decorate`, `beforeHandle`, `afterHandle`, `around`, `aroundCapability`, `onError`) added to a `createWebApp` app after it returns now throws a `FrameworkError` with code `HOOK_AFTER_PAGES` outside production, naming the call site. Every page copies its hook chain when it is declared, so such a hook never ran on a page. 4.x accepted it without a word. Apply it in `createWebApp({ use })`, or inside `app.group(prefix, ...)` to scope it to the routes declared there. Global hooks (`onRequest`, `onResponse`), routes, groups and re-applying a named plugin that `use` already applied stay allowed.
