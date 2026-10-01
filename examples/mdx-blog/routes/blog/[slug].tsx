import type { LoaderData } from "@nifrajs/client"
import type { MetaArgs } from "@nifrajs/web"
import { trustHtml } from "@nifrajs/web"
import { Content } from "@nifrajs/web-solid/content"
import type { loader } from "./[slug].backend.ts"

export function meta({ data }: MetaArgs<LoaderData<typeof loader>>) {
  return { title: data.title }
}

export default function Post(props: { data: LoaderData<typeof loader> }) {
  return (
    <article id="post">
      <p>
        <a href="/">← back to posts</a>
      </p>
      {/* Renders the Markdown-rendered HTML via Solid's innerHTML (the <Content> helper). */}
      <Content html={trustHtml(props.data.html)} />
    </article>
  )
}
