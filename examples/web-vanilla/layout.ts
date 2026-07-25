import { html, type Template } from "@nifrajs/web-vanilla"

// Root layout - wraps the page via `props.children` (the compose fold passes the child there).
export function Layout(props: { children?: Template }): Template {
  return html`<div class="wrap">${props.children}</div>`
}
