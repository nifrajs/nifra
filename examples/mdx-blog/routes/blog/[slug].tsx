import type { MetaArgs } from "@nifrajs/web"
import { trustHtml } from "@nifrajs/web"
import { href } from "@nifrajs/web-react/router"
import { Content } from "@nifrajs/web-solid/content"
import type { Route } from "./+types/[slug]"

export function meta({ data }: MetaArgs<Route.LoaderData>) {
  return { title: data.title }
}

export default function Post(props: Route.ComponentProps) {
  return (
    <article id="post">
      <p>
        <a href={href({ to: "/" })}>← back to posts</a>
      </p>
      {/* Renders the Markdown-rendered HTML via Solid's innerHTML (the <Content> helper). */}
      <Content html={trustHtml(props.data.html)} />
    </article>
  )
}
