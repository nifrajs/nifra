import { expect, test } from "bun:test"
import { useParams, useSearch } from "../src/router.ts"

// The full matrix (every route shape x every adapter) is `internal/invariants/test/type-e2e.test.ts`;
// these are the refusals a typo gets, checked by the typecheck gate.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/search-typed/:id": {
      readonly params: { readonly id: string }
      readonly search: { readonly page: number }
    }
  }
}

// Never called: the hooks need a render context, and the assertions here are about types.
function typeChecks(): void {
  const { page } = useSearch("/search-typed/:id").value
  const n: number = page
  // @ts-expect-error - a pattern the route table does not hold.
  useSearch("/nope")
  // @ts-expect-error - a pattern the route table does not hold.
  useParams("/nope")
  // @ts-expect-error - the route is named by its pattern, not left out.
  useSearch()
  void n
}

test("useSearch and useParams take a route pattern", () => {
  expect(typeof typeChecks).toBe("function")
})
