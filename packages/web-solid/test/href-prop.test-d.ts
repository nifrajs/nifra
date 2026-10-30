import { type Href, rawHref } from "@nifrajs/web"
import { type Component, createComponent } from "solid-js"

declare const path: string
declare const HrefLink: Component<{ readonly to: Href }>

createComponent(HrefLink, { to: rawHref("/x") })
// @ts-expect-error a string literal
createComponent(HrefLink, { to: "/x" })
// @ts-expect-error a template literal
createComponent(HrefLink, { to: `/users/${path}` })
// @ts-expect-error a string variable
createComponent(HrefLink, { to: path })
