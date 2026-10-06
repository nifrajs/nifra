import { t } from "@nifrajs/schema"
import {
  type ComponentState,
  defineServerComponent,
  type ServerComponentContext,
} from "@nifrajs/web/server-components"
import type { ComponentClientAdapter } from "@nifrajs/web/server-components/client"
import { clientIsland, defineClientIsland } from "@nifrajs/web/server-components/islands"
import { ServerComponent as PreactOutlet } from "@nifrajs/web-preact/server-components/outlet"
import { ServerComponent as ReactOutlet } from "@nifrajs/web-react/server-components/outlet"
import { ServerComponent as SolidOutlet } from "@nifrajs/web-solid/server-components/outlet"
import SvelteOutlet from "@nifrajs/web-svelte/server-components/outlet"
import {
  createServerComponentOutlet,
  ServerComponent as VueOutlet,
} from "@nifrajs/web-vue/server-components/outlet"
import type { FunctionComponent as PreactFunctionComponent } from "preact"
import type { FunctionComponent } from "react"
import type { Component as SolidComponent } from "solid-js"
import type { Component as SvelteComponent } from "svelte"
import { defineComponent, h } from "vue"

const component = defineServerComponent({
  input: t.object({ id: t.string() }),
  props: t.object({ title: t.string() }),
  authorize() {},
  load: () => ({ title: "Public" }),
  view: ({ props }) => props.title,
})
declare const state: ComponentState
declare const clientAdapter: ComponentClientAdapter
declare const context: ServerComponentContext
const outlet = { state, component, instanceKey: "stable", input: { id: "public" }, clientAdapter }
ReactOutlet(outlet)
PreactOutlet(outlet)
VueOutlet(outlet)
const TypedVueOutlet = createServerComponentOutlet(component)
h(TypedVueOutlet, { state, instanceKey: "stable", input: { id: "public" }, clientAdapter })
// @ts-expect-error Vue h keeps the schema contract after outlet specialization.
h(TypedVueOutlet, { state, instanceKey: "stable", input: { id: 42 }, clientAdapter })
SolidOutlet(outlet)
// Svelte's generated callable ABI has a compiler-owned first argument; this file only typechecks it.
SvelteOutlet(null!, outlet)
// @ts-expect-error Inputs are derived from the server schema.
ReactOutlet({ ...outlet, input: { id: 42 } })
// @ts-expect-error Vue keeps the same schema-derived input contract.
VueOutlet({ ...outlet, input: { id: 42 } })
// @ts-expect-error Solid keeps the same schema-derived input contract.
SolidOutlet({ ...outlet, input: { id: 42 } })
// @ts-expect-error Preact input must retain the schema-derived string type.
PreactOutlet({ ...outlet, input: { id: 42 } })
// @ts-expect-error Svelte declarations keep the same schema-derived input contract.
SvelteOutlet(null!, { ...outlet, input: { id: 42 } })
const island = defineClientIsland({ props: t.object({ title: t.string() }), component: () => null })
clientIsland(island, "stable", { title: "Public" })
declare const reactIsland: FunctionComponent<{ title: string }>
declare const preactIsland: PreactFunctionComponent<{ title: string }>
declare const solidIsland: SolidComponent<{ title: string }>
declare const svelteIsland: SvelteComponent<{ title: string }>
const vueIsland = defineComponent({ props: { title: { type: String, required: true } } })
defineClientIsland({ props: t.object({ title: t.string() }), component: reactIsland })
defineClientIsland({ props: t.object({ title: t.string() }), component: preactIsland })
defineClientIsland({ props: t.object({ title: t.string() }), component: vueIsland })
defineClientIsland({ props: t.object({ title: t.string() }), component: svelteIsland })
defineClientIsland({ props: t.object({ title: t.string() }), component: solidIsland })
// @ts-expect-error React's native props must accept the schema projection.
defineClientIsland({ props: t.object({ title: t.number() }), component: reactIsland })
// @ts-expect-error Preact native props must accept schema projection.
defineClientIsland({ props: t.object({ title: t.number() }), component: preactIsland })
// @ts-expect-error Vue's required props must be satisfied by the schema projection.
defineClientIsland({ props: t.object({}), component: vueIsland })
// @ts-expect-error Svelte's native props must accept the schema projection.
defineClientIsland({ props: t.object({ title: t.number() }), component: svelteIsland })
// @ts-expect-error Solid's native props must accept the schema projection.
defineClientIsland({ props: t.object({ title: t.number() }), component: solidIsland })
// @ts-expect-error Public props cannot contain undeclared fields.
clientIsland(island, "stable", { title: "Public", secret: "forbidden" })
// @ts-expect-error Private execution context cannot cross the public props seam.
clientIsland(island, "stable", context)
defineServerComponent({
  input: t.object({}),
  props: t.object({ title: t.string() }),
  authorize() {},
  load: () => ({}),
  view: ({ props }) => {
    // @ts-expect-error Dropped public fields are a compile error in the server view too.
    return props.missing
  },
})
