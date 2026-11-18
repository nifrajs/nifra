---
"@nifrajs/web-solid": minor
"@nifrajs/web": minor
"create-nifra": minor
---

`@nifrajs/web-solid` targets Solid 2.0 (`solid-js` and `@solidjs/web` ^2.0.0) and builds with `@solidjs/compiler`, so `babel-preset-solid`, `solid-refresh` and Babel are no longer dependencies. Solid 1.x is not supported. Apps use `@solidjs/vite-plugin` ^3.0.1 for Vite, set `jsxImportSource` to `@solidjs/web`, and drop the `"solid"` resolve condition. Components that used `createResource`, `Suspense`, `ErrorBoundary`, `onMount`, `Dynamic` or `Context.Provider` move to `createMemo` under `Loading`, `Errored`, `onSettled`, `dynamic()` and the context component.

`RouteSlotHooks` takes the Solid 2 `createEffect(compute, effect)` shape and no longer has `onCleanup`. Server render errors reach the client as a bare error in production, with no server path.

`create-nifra` scaffolds Solid sites on Solid 2.
