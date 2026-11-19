import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { compose } from "../src/compose.ts"
import { useParams, useSearch } from "../src/router.ts"

// The full matrix (every route shape x every adapter) is `internal/invariants/test/type-e2e.test.ts`;
// this is the React hook's runtime read plus the refusals a typo gets.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/hooks-typed/:id": {
      readonly params: { readonly id: string }
      readonly search: { readonly page: number }
    }
  }
}

test("useParams and useSearch read the route's entry in the table", () => {
  const Page = () => {
    const { id } = useParams("/hooks-typed/:id")
    const { page } = useSearch("/hooks-typed/:id")
    const n: number = page
    // @ts-expect-error - the route has no `slug` param.
    useParams("/hooks-typed/:id").slug
    // @ts-expect-error - `page` is a number for this route, not a string.
    const wrong: string = useSearch("/hooks-typed/:id").page
    // @ts-expect-error - a pattern the route table does not hold.
    useParams("/hooks-typed/:nope")
    // @ts-expect-error - a pattern the route table does not hold.
    useSearch("/nope")
    // @ts-expect-error - the route is named by its pattern, not left out.
    useSearch()
    void wrong
    return createElement("span", null, `${id}|${n}`)
  }
  const html = renderToStaticMarkup(
    compose([Page], {
      data: null,
      params: { id: "7" },
      search: { page: 2 },
      path: "/hooks-typed/7?page=2",
    }),
  )
  expect(html).toContain("<span>7|2</span>")
})
