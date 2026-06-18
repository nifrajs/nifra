/** Root layout — nav across the collection index + the MDX page. */
export default function Layout(props: { children?: unknown }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">posts</a> · <a href="/about">about (mdx)</a>
      </nav>
      {props.children as never}
    </div>
  )
}
