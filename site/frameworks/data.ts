/**
 * The single, static catalog payload shared by every framework row of the /frameworks live demo.
 *
 * It re-exports the EXACT same 50-item loader the SSR bench apps use (`bench/ssr/shared/catalog.ts`)
 * so the showcase is honest: one data loader, five renderers. The route embeds this JSON once into the
 * page; each framework's client entry hydrates from it. Keep it free of any framework import — it's
 * consumed by the React/Preact/Vue render path, both prebuilt (Solid/Svelte) SSR entries, every client
 * bundle, and the route itself.
 */
export {
  type CatalogItem,
  type CatalogPageData,
  catalogItems,
} from "../../bench/ssr/shared/catalog.ts"

/** Global the /frameworks page serializes the catalog into; each framework client entry reads it to
 * hydrate. Distinct from `@nifrajs/web`'s `__NIFRA_DATA__` (the React page-route data) so the showcase
 * island's data never collides with the host route's own hydration channel. */
export const FRAMEWORK_DATA_GLOBAL = "__NIFRA_FW_DATA__"

/** Each framework hydrates its OWN stage container (`fw-stage-<id>`) — they sit side by side, only the
 * active one is shown, and each hydrates once on first activation and then stays live (the toggle just
 * flips visibility). The host route is `hydrate: false`, so these stages are owned entirely by whichever
 * framework bundles the toggle island has loaded. */
export const frameworkStageId = (id: string): string => `fw-stage-${id}`
