---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

React server-component owner refreshes for one selected component without descendants can progressively commit ready Suspense content through a bounded Flight stream. Other adapters, multi-component selections, and refreshes with descendants use the buffered response path. Owner routes may explicitly opt into ISR when their complete output is request-independent and anonymous; Nifra disables shared storage when route, layout, middleware, component authorization/loading, or app hooks registered through `createWebApp({ use })` read request headers. Uninspectable request replacements fail closed. The `requestIndependent` declaration remains the application's assertion for dependencies Nifra cannot observe, such as database, environment, global, or external-service state, and hooks attached after app creation. Cache entries are isolated by deployment, build, adapter, route, and canonical URL, while responses sent to clients remain `private, no-store`. Pass the same app to `revalidateEndpoint({ app, store, secret })` to purge an owner route by path.
