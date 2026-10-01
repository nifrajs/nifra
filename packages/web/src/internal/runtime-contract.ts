/** Phantom brand key for {@link BackendOnly}. */
declare const BACKEND_ONLY_BRAND: unique symbol

/**
 * Type-level intent marker for a value that must only exist on the server - a secret, a DB handle, a
 * server-only client. `BackendOnly<T>` is structurally `T` (the brand is an optional phantom field, so
 * existing code keeps type-checking), but it advertises to readers + the compiler that the value is
 * not meant to cross to the browser. It is **purely type-level** and erases at build - it does NOT,
 * by itself, keep the value out of the client bundle.
 *
 * The enforcement is the zone rules: code under `backend/` or in a `*.backend.ts` file never reaches a
 * browser build, and a module that imports `@nifrajs/web/backend-only` fails every browser build that
 * reaches it, wherever it lives.
 *
 * @example
 * import "@nifrajs/web/backend-only"
 * import type { BackendOnly } from "@nifrajs/web"
 * export const apiKey: BackendOnly<string> = process.env.SECRET_API_KEY!
 */
export type BackendOnly<T> = T & { readonly [BACKEND_ONLY_BRAND]?: never }

/**
 * Pre-hydration form guard - a tiny inline script flushed in `<head>` (it runs in the window between
 * first paint and the island bundle taking over). It neutralizes the one real hydration footgun: a
 * JS-only form (a hand-wired `onSubmit` with no native fallback) submitting *natively* before its
 * handler is attached, which navigates the browser to a broken `?field=…` GET of the current page.
 *
 * It blocks ONLY that shape - an effective-GET form whose action targets the current document - and
 * only until hydration commits (`data-nifra-hydrated`, set by the client entry). Method-`post` forms
 * (progressive enhancement: the native POST hits the route `action`) and GET forms with a real action
 * (a search box → `/search`) pass through untouched. Opt out per-form with `data-native`. Static text
 * (no interpolation), so it can't carry injected markup. See the Hydration guide.
 */
export const PRE_HYDRATION_GUARD =
  "(function(){addEventListener('submit',function(e){var f=e.target;" +
  "if(!f||f.tagName!=='FORM'||f.hasAttribute('data-native'))return;" +
  "if(document.documentElement.hasAttribute('data-nifra-hydrated'))return;" +
  "var m=(f.getAttribute('method')||'get').toLowerCase();if(m==='post')return;" +
  "var a=f.getAttribute('action');" +
  "if(!a||a===''||a==='#'||a===location.pathname||a===location.href)e.preventDefault()" +
  "},true)})()"

/**
 * The single default port for the dev server (`@nifrajs/web/dev`, `@nifrajs/web/vite`) **and**
 * `nifra start`. Deliberately uncommon: `3000`/`5173`/`8080` collide with whatever else is running
 * (Next, Vite, a stray Node API). `4321` rarely is - and being the *same* constant across `nifra dev`
 * and `nifra start` means a project's URL doesn't change between commands. Override per-run with
 * `--port <n>` or the `PORT` env var. */
export const DEFAULT_DEV_PORT = 4321
