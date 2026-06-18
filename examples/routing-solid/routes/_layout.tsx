/** Root layout — wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: unknown }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/users/7">user 7</a> · <a href="/slow">streaming</a>
      </nav>
      {props.children as never}
    </div>
  )
}
