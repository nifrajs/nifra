/** A Solid layout — wraps the page via `props.children`. Composed by the chain in server.ts. */
export default function Layout(props: { children?: unknown }) {
  return (
    <div class="app">
      <nav id="nav">nifra · solid · F2.1 layout</nav>
      {props.children as never}
    </div>
  )
}
