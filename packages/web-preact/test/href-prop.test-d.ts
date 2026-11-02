import { type Href, rawHref } from "@nifrajs/web"
import { h } from "preact"

declare const path: string

// A component that wraps <a> takes `to: Href`, and an Href is a string where the anchor wants one.
const HrefLink = (props: { readonly to: Href }) => h("a", { href: props.to })

h(HrefLink, { to: rawHref("/x") })
// @ts-expect-error a string literal
h(HrefLink, { to: "/x" })
// @ts-expect-error a template literal
h(HrefLink, { to: `/users/${path}` })
// @ts-expect-error a string variable
h(HrefLink, { to: path })
