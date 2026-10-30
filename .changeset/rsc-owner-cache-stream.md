---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

React server-component owner refreshes can progressively commit ready Suspense content through a bounded Flight stream. Owner routes may explicitly opt into ISR when their complete output is request-independent and anonymous; cache entries are isolated by deployment, build, adapter, and route, while responses sent to clients remain `private, no-store`. Pass the same app to `revalidateEndpoint({ app, store, secret })` to purge an owner route by path.
