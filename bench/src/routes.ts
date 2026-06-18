/**
 * A representative REST route set and the request paths we resolve against it.
 * Shared by every router in the comparison so the benchmark is apples-to-apples.
 * All three routers (nifra, memoirist, hono RegExpRouter) accept this `:param`
 * and trailing `*` syntax.
 */
export interface RouteDef {
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  readonly path: string
}

export const ROUTES: readonly RouteDef[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/users" },
  { method: "POST", path: "/users" },
  { method: "GET", path: "/users/:id" },
  { method: "PUT", path: "/users/:id" },
  { method: "DELETE", path: "/users/:id" },
  { method: "GET", path: "/users/:id/posts" },
  { method: "GET", path: "/users/:id/posts/:postId" },
  { method: "GET", path: "/posts" },
  { method: "GET", path: "/posts/:slug" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/static/*" },
]

export const STATIC_REQUEST = { method: "GET", path: "/health" } as const
export const PARAM_REQUEST = { method: "GET", path: "/users/123/posts/456" } as const
