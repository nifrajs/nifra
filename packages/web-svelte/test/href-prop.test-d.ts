import { type Href, rawHref } from "@nifrajs/web"
import { type Component, mount } from "svelte"

declare const path: string
declare const target: HTMLElement
declare const HrefLink: Component<{ to: Href }>

mount(HrefLink, { target, props: { to: rawHref("/x") } })
// @ts-expect-error a string literal
mount(HrefLink, { target, props: { to: "/x" } })
// @ts-expect-error a template literal
mount(HrefLink, { target, props: { to: `/users/${path}` } })
// @ts-expect-error a string variable
mount(HrefLink, { target, props: { to: path } })
