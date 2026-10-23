import type { JSX } from "solid-js"

// The second rule stops matching inside the slot wrappers: the dev client's D10 check reports it.
const CSS = ".list-page { min-height: 1400px } #main > .list-page { outline: 1px solid }"

export default function Layout(props: { readonly children?: JSX.Element }) {
  return (
    <div class="shell">
      <style innerHTML={CSS} />
      <nav>
        <a href="/">home</a> <a href="/list/1">list 1</a> <a href="/list/2">list 2</a>{" "}
        <a href="/list/3">list 3</a> <a href="/detail/1">detail 1</a> <a href="/shop/a">shop a</a>{" "}
        <a href="/shop/b">shop b</a>
      </nav>
      <main id="main">{props.children}</main>
    </div>
  )
}
