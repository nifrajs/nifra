import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta("/docs/server-components", "Nifra - Server components", "Server-only views with schema-guarded props, owner-route authorization and native React, Vue, Svelte, Solid and Preact hydration.")

const DEFINE = `// Product.component.server.ts - native Vue/Svelte/Solid view.
import { t } from "@nifrajs/schema"
import { defineServerComponent, type ServerComponentContext } from "@nifrajs/web/server-components"
import { nativeServerView } from "@nifrajs/web/server-components/islands"

// Replace these declarations with your native view and scoped read service.
declare const ProductView: unknown
declare function readProduct(ctx: ServerComponentContext, id: string): Promise<{ title: string; internal: string }>

export const Product = defineServerComponent({
  input: t.object({ id: t.string({ minLength: 1 }) }),
  props: t.object({ title: t.string() }),
  authorize(ctx, input) {
    if (ctx.params.id !== input.id) throw new Response(null, { status: 403 })
  },
  load: (ctx, input) => readProduct(ctx, input.id),
  view: () => nativeServerView(ProductView),
})`

const OWNER = `// doc-check: skip - complete application entries are in examples/server-components.
import { createWebApp } from "@nifrajs/web"
import { componentBuild } from "@nifrajs/web/server-components/build-info"
import { createServerComponents, serverComponentInstance } from "@nifrajs/web/server-components"
import { vueServerComponents } from "@nifrajs/web-vue/server-components"
import { Product } from "./Product.component.server"

const components = createServerComponents({
  build: componentBuild,
  adapter: vueServerComponents(),
  owners: {
    product: { // exact manifest route id, not a URL pattern
      components: [Product],
      scope: "anonymous", // personalized pages supply a public auth-scope token
      instances: (ctx) => [serverComponentInstance(Product, "product", { id: ctx.params.id })],
    },
  },
})

export function createApp(clientEntry: string, assets: { styles?: readonly string[] }) {
  return createWebApp({ adapter, manifest, clientEntry, styles: assets.styles, serverComponents: components })
}`

const CONFIG = `// doc-check: skip - Vue compiler is an app dependency; the isolated tarball consumer compiles this config with the pinned plugin.
// nifra.config.ts - named exports; no default config object.
import vue from "@vitejs/plugin-vue"
import { vueAdapter } from "@nifrajs/web-vue"
export const adapter = vueAdapter
export const clientModule = "@nifrajs/web-vue/client"
export const vitePlugins = [vue()]
export const componentPipeline = {
  adapter: "vue" as const,
  entries: { client: "entry.client.ts", ssr: "entry.backend.ts" },
}
// entry.backend.ts exports createApp(clientEntry, assets).
// React also requires entries.rsc and an RSC renderer registry.`

const ISLAND = `// Counter.island.ts - compiler assigns an opaque reference.
import { t } from "@nifrajs/schema"
import { defineClientIsland, clientIsland } from "@nifrajs/web/server-components/islands"
declare function Counter(props: { title: string }): null

export const counter = defineClientIsland({
  props: t.object({ title: t.string() }), component: Counter, slots: ["summary"],
})
// Inside a server view, pass this named island to nativeServerView(...).
export const instance = clientIsland(counter, "counter", { title: "Public title" }, {
  summary: "<p>Server-owned summary</p>",
})`

const CLIENT = `// doc-check: skip - integrate with the native client entry, not a second page root.
import { ComponentController, bindComponentRouter, invalidateComponentScope,
  parseComponentState, refreshAfterComponentMutation } from "@nifrajs/web/server-components/client"
import { vueComponentClient } from "@nifrajs/web-vue/server-components/client"
import { counter } from "./Counter.island"

const state = parseComponentState(hydrationState)
const clientAdapter = vueComponentClient({ islands: [counter] })
const controller = new ComponentController({ state, adapter: clientAdapter })
// Pass state, controller and clientAdapter to the page's native outlet.
const stop = bindComponentRouter(router)
await refreshAfterComponentMutation(save({ text }), controller, [state.records[0].instance])
await invalidateComponentScope() // await this on logout or permission/tenant changes
// On application disposal: stop(); await controller.dispose()`

const VUE_OUTLET = `// doc-check: skip - component fragment; Product is a compiler-generated client handle.
import { h } from "vue"
import { createServerComponentOutlet } from "@nifrajs/web-vue/server-components/outlet"
import { Product } from "./Product.component.server"
const ProductOutlet = createServerComponentOutlet(Product)
// Specialization keeps h() and SFC template inputs tied to Product's schema.
h(ProductOutlet, { state, instanceKey: "product", input: { id }, controller, clientAdapter })`

const TUPLE = [
  ["React / React DOM / Flight", "19.3.1 / 19.3.1 / 19.3.1"],
  ["Vue / plugin-vue", "3.5.40 / 6.0.9"],
  ["Svelte / plugin-svelte", "5.56.8 / 7.3.1"],
  ["Solid / vite-plugin-solid", "1.9.14 / 2.11.14"],
  ["Preact / render-to-string / preset-vite", "10.29.8 / 6.7.0 / 2.10.5"],
  ["Vite / plugin-rsc", "8.3.4 / 0.5.35"],
  ["TypeScript", "6.0.3"],
] as const

export default function ServerComponents() {
  return <div className="prose">
    <h1 className="page">Server components</h1>
    <p className="lead">Compose server-only views and refresh their content while keeping native client state. React uses RSC and Flight; Vue, Svelte, Solid and Preact use server-rendered ranges with their own client islands.</p>
    <p>This additive feature is intended for the release after 4.0.0. It requires all five adapters to pass the same certification. Ordinary SSR, loaders, islands and server functions keep their existing APIs.</p>

    <h2>Execution and public props</h2>
    <p>A <code>*.component.server.ts</code> or <code>*.component.server.tsx</code> module declares a closed input schema, closed public-props schema, authorization, a read operation and a view. The compiler replaces browser imports with an opaque typed handle. The server implementation and its imports stay in the server build.</p>
    <CodeBlock code={DEFINE} lang="ts" />
    <p>The input is validated before component authorization and loading. The load result is projected through the props schema, so undeclared fields such as <code>internal</code> never reach the view or browser. The view receives <code>{"{ props, children }"}</code>. Public values are bounded JSON: finite numbers, strings, booleans, null, arrays and plain objects. Functions, framework contexts, requests, bindings, class instances and executable closures cannot cross this seam.</p>
    <p>Keep ownership checks in the scoped read service too. Every definition requires an authorization callback. Use <code>inheritOwnerAuthorization</code> only when the owning route already enforces the full resource authorization; it records an intentional choice to reuse that admission.</p>

    <h2>Register the owning page</h2>
    <CodeBlock code={OWNER} lang="ts" />
    <p>The owner lists the components and instances that may execute. A browser cannot invent a new instance or change its input. Initial HTML and hydration state reuse one execution. A refresh sends a bounded <code>x-nifra-component</code> selection to the actual owning page URL using same-origin GET.</p>
    <p>Hooks, filesystem middleware, gate layouts, ordinary layouts and the page loader run before component work on both initial requests and refreshes. Ordinary layout and page loaders retain their parallel execution; use <code>gate: true</code> when a layout must block the page loader. Component execution preserves the admitted request's environment, API, response controls, cancellation, budgets and effect accounting.</p>
    <p>Owners declare allowed capabilities and definitions may narrow that set. Domain writes are rejected in this GET path. Mutate through a validated <a href="/docs/server-functions">server function</a> or route action, then refresh after success. Native React <code>"use server"</code> actions and serialized closures are unsupported.</p>
    <p>A partially prerendered page can instead show a component in a hole, rendered for each visitor after the shared shell; its route lists the component under <code>holes</code> rather than <code>owners</code>. See <a href="/docs/partial-prerendering">partial prerendering</a>.</p>

    <h2>Native views and client islands</h2>
    <p>React definitions return JSX in the RSC environment. Register every definition with <code>createReactComponentRenderer</code> in the RSC entry, and connect that renderer through <code>reactServerComponents</code> in the SSR entry. Imported <code>"use client"</code> exports require a companion <code>*.props.ts</code> with a matching closed schema for every export. The compiler guards element creation and cloning before a client prop handoff.</p>
    <p>Vue, Svelte, Solid and Preact definitions return <code>nativeServerView(View, islands, ranges)</code>. Their native view receives public <code>props</code> plus named island and nested-range markup. Use <code>vueServerComponents()</code>, <code>svelteServerComponents()</code> or <code>solidServerComponents()</code> or <code>preactServerComponents()</code> with the matching client adapter.</p>
    <p>Preact uses <code>preactServerComponents()</code> from <code>@nifrajs/web-preact/server-components</code>, <code>{"preactComponentClient({ islands })"}</code> from its <code>/client</code> subpath, and a typed <code>ServerComponent</code> from its <code>/outlet</code> subpath. Pass the controller or client adapter to the outlet and hydrate with Preact. Use <code>@preact/preset-vite</code> for JSX and development updates. Preact uses native Preact roots; <code>preact/compat</code> does not supply React Flight.</p>
    <CodeBlock code={ISLAND} lang="ts" />
    <p>A stable island reference, key and parent keep the native root, state, DOM node, focus and text selection. Changed keys remount. Removal awaits disposal; reappearance mounts a fresh root. Named slots contain validated server-owned HTML. Nested ranges must refer to registered children of that parent. Use <code>serverComponentIdentity</code> when registering a child's parent and <code>serverComponentChild</code> when selecting a child's render.</p>
    <p>Each component range has its own native root. Native context belongs to that root and its descendants; outer page context is not implicitly shared across independent roots. Pass explicit public data when a separate root needs it. Managed portals must use <code>componentPortalTarget</code> from <code>@nifrajs/web/server-components/portal</code>; targets outside the owned range are rejected and cleanup is awaited.</p>
    <p>Outlets are available from each adapter's <code>/server-components/outlet</code> export. React, Solid and Preact export <code>ServerComponent</code>; Svelte exports a native generic component as default. Vue also offers a specialized outlet for render functions and templates:</p>
    <CodeBlock code={VUE_OUTLET} lang="ts" />

    <h2>Client entry, navigation and mutations</h2>
    <CodeBlock code={CLIENT} lang="ts" />
    <p>Use <code>props.serverComponents</code> from the server render to initialize the outlet and controller. Hydrate with the adapter's native API. Install <code>bindComponentRouter</code> for navigation, retained layouts, history and action revalidation, and dispose its subscription with the application. Mutation helpers refresh only an <code>ok: true</code> result; failures keep the current content.</p>
    <p>Auth-scope tokens are public identifiers, never cookies or credentials. Personalized owners must change their scope when identity, tenant or permissions change. Await <code>invalidateComponentScope()</code> before displaying another subject's content. Invalidation clears private records and native roots; subsequent authorized navigation can restore structural outlets. Denied refreshes also clear the scope.</p>
    <p>Route epochs, auth epochs, generations and build IDs prevent obsolete fetches, imports or native preparation from committing. A failed update disposes the affected range and reports a typed error. There is no automatic 4xx retry. Version mismatch permits at most one controlled document reload for that build.</p>

    <h2>Build and development</h2>
    <CodeBlock code={CONFIG} lang="ts" />
    <p><code>nifra dev</code> and <code>nifra build --target node</code> select the coordinated Vite pipeline when <code>componentPipeline</code> is exported. Other targets are <code>bun</code>, <code>deno</code>, <code>cloudflare</code> and <code>vercel</code>. Bun remains a supported runtime. The programmatic APIs are <code>buildServerComponents</code> and <code>devServerComponents</code> from <code>@nifrajs/web/server-components/build</code>.</p>
    <p>The pipeline has complete application client/SSR entries; React adds an RSC entry. It generates target serving code, an integrity manifest and one generation across server and client assets. It rejects an ordinary backend import into client code, unregistered client props, unsupported target builtins, foreign references and mixed build generations. Source edits restart all development environments together. <code>nifra check --json</code> validates source receipts without executing configuration.</p>
    <p>Keep the certified compiler tuple pinned in the application lockfile. React's framework-facing RSC APIs require exact alignment even when ordinary React SSR allows a broader peer range. The pipeline reads component modules with the TypeScript compiler API, which TypeScript 7 does not ship: on TypeScript 7 the build stops with <code>NIFRA_TS_UNSUPPORTED</code>, and <code>nifra check</code> reports the same code and checks each component module as an ordinary backend import.</p>
    <table><thead><tr><th>Dependency</th><th>Certified tuple</th></tr></thead><tbody>{TUPLE.map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td></tr>)}</tbody></table>
    <p>The runtime matrix covers Bun 1.3.14 and 1.4.3, Node 22.23.3 and 26.12.0, Deno 2.0.0 and 2.9.7, Cloudflare Workers and Pages under workerd compatibility date 2026-09-18, and Vercel's Node 22 entry. Browser certification uses Playwright 1.63.0 with Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. Vanilla retains ordinary SSR; its server-component opt-in is rejected.</p>

    <h2>Streaming, caching and CSP</h2>
    <p>Rendering is bounded before it becomes a verified record. React's exact Flight bytes produce both initial HTML and the hydration payload. Refresh uses a bounded framed stream; the client validates the entire result before native preparation and commit. This first release does not progressively commit partial component trees or expose a generic component-defer API.</p>
    <p>Component HTML, page-data and refresh responses are <code>private, no-store</code>. ISR lookup, public fragment caching and static prerendering are bypassed or rejected for opted-in owners. Use ordinary SSR routes for public cached pages. A nonce must be fresh per response; pass it through <code>createWebApp</code>. Strict CSP and Chromium Trusted Types are covered by the browser suite. If your policy requires Trusted Types, install <code>installComponentTrustedTypesPolicy()</code> from <code>@nifrajs/web/server-components/trusted-html</code> before hydration and allow the native framework's policy where required.</p>
    <p>HTML, URLs, styles, slots and portal targets are validated before insertion. React-owned bootstrap scripts require the expected nonce; raw executable HTML and foreign script/assets are rejected. Per-input, per-stream, per-document, depth, concurrency, queue and deadline limits fail closed. Cancellation propagates to reads and native work; an uncooperative promise retains its admission slot until it settles.</p>
    <p>Forms work without JavaScript. Successful actions reauthorize the owner GET exactly once. Parent-domain cookie changes, and Secure cookies on a request the app sees as <code>http:</code> (a TLS terminator in front), return 303 to the same path so the browser applies its cookie policy before the GET, preserving the action headers and cookies.</p>

    <h2>Examples, verification and rollback</h2>
    <p>The repository contains runnable React, Vue, Svelte, Solid and Preact examples under <code>examples/server-components/</code>. They exercise native islands, nested ranges, slots, portals, actions and navigation. Their data, scope tokens and fixed nonce are certification fixtures; replace them with scoped application services, auth integration and fresh nonces before deployment.</p>
    <CodeBlock code={`bun examples/server-components/react/run.ts\nbun examples/server-components/vue/run.ts\nbun examples/server-components/svelte/run.ts\nbun examples/server-components/solid/run.ts\n# Add build to emit a Bun production application.\nbun run check:server-components\nbun run check:server-components:consumers\nbun run check:server-components:performance`} lang="bash" />
    <p>Deploy the complete server build, integrity manifest and immutable assets together. Keep old hashed assets for the deployment overlap window. Roll back by redeploying the previous complete build. Disabling components requires rebuilding the application with an ordinary SSR fallback; component source cannot be dropped unchanged into an older runtime.</p>
  </div>
}
