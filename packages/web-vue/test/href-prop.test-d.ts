import { type Href, rawHref } from "@nifrajs/web"
import { defineComponent, h } from "vue"

declare const path: string

const HrefLink = defineComponent(
  (props: { readonly to: Href }) => () => h("a", { href: props.to }),
  {
    props: ["to"],
  },
)

h(HrefLink, { to: rawHref("/x") })
// @ts-expect-error a string literal
h(HrefLink, { to: "/x" })
// @ts-expect-error a template literal
h(HrefLink, { to: `/users/${path}` })
// @ts-expect-error a string variable
h(HrefLink, { to: path })
