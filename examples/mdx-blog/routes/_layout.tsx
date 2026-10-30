/** Root layout - nav across the collection index + the MDX page. */
import { href } from "@nifrajs/web-react/router"

export default function Layout(props: { children?: unknown }) {
  return (
    <div>
      <nav id="nav">
        <a href={href({ to: "/" })}>posts</a> · <a href={href({ to: "/about" })}>about (mdx)</a>
      </nav>
      {props.children as never}
    </div>
  )
}
