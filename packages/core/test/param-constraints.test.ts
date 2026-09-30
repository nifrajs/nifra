import { describe, expect, test } from "bun:test"
import { RouteConfigError, server } from "../src/index.ts"
import { RoutePatternOverlapLimitError, routePatternOverlap } from "../src/router/overlap.ts"
import {
  compileRoutePattern,
  expandOptionalParams,
  matchRoutePattern,
  paramConstraint,
} from "../src/router/pattern.ts"
import { Router } from "../src/router/router.ts"

const routerOf = (...patterns: string[]): Router<string> => {
  const router = new Router<string>()
  for (const pattern of patterns) router.add("GET", pattern, pattern)
  return router
}
const hit = (router: Router<string>, path: string) => {
  const match = router.find("GET", path)
  return match.found ? { payload: match.payload, params: match.params } : undefined
}
const route = (router: Router<string>, path: string): string | undefined =>
  hit(router, path)?.payload

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof RouteConfigError ? error.code : `not a RouteConfigError: ${error}`
  }
  return undefined
}

/** Every ordering of `items`. */
function orderings<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]]
  return items.flatMap((item, index) =>
    orderings([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}

describe("paramConstraint", () => {
  test("a class with a count", () => {
    expect(paramConstraint("{[0-9]+}")).toMatchObject({ source: "[0-9]+", min: 1, max: Infinity })
    expect(paramConstraint("{[a-z]{3}}")).toMatchObject({ source: "[a-z]{3}", min: 3, max: 3 })
    expect(paramConstraint("{[a-z]{2,}}")).toMatchObject({ min: 2, max: Infinity })
    expect(paramConstraint("{[a-z]{2,4}}")).toMatchObject({ min: 2, max: 4 })
    expect(paramConstraint("{[a-z]}")).toMatchObject({ min: 1, max: 1, size: 26 })
    expect(paramConstraint("{\\d+}")).toMatchObject({ source: "\\d+", size: 10 })
    expect(paramConstraint("{\\w{8}}")).toMatchObject({ min: 8, max: 8, size: 63 })
    expect(paramConstraint("{[\\w.-]+}")).toMatchObject({ size: 65 })
  })

  test("a list of values, kept in the order written", () => {
    const list = paramConstraint("{png|jpg|webp}")
    expect(list?.oneOf).toEqual(["png", "jpg", "webp"])
    expect(list?.size).toBe(3)
  })

  test("only the constraint at the front is read, and its length is reported by `source`", () => {
    expect(paramConstraint("{[0-9]+}.json")?.source).toBe("[0-9]+")
    expect(paramConstraint("{[0-9]+}?")?.source).toBe("[0-9]+")
    expect(paramConstraint("x{[0-9]+}")).toBeUndefined()
  })

  test("two spellings of one constraint share a key", () => {
    expect(paramConstraint("{\\d+}")?.key).toBe(paramConstraint("{[0-9]+}")?.key)
    expect(paramConstraint("{[0-9]+}")?.key).toBe(paramConstraint("{[0-9]{1,}}")?.key)
    expect(paramConstraint("{[a-c]}")?.key).toBe(paramConstraint("{[cab]{1}}")?.key)
    expect(paramConstraint("{a|b}")?.key).toBe(paramConstraint("{b|a}")?.key)
    expect(paramConstraint("{[0-9]+}")?.key).not.toBe(paramConstraint("{[0-9]{2,}}")?.key)
    expect(paramConstraint("{[0-9]+}")?.key).not.toBe(paramConstraint("{[0-8]+}")?.key)
  })

  test.each([
    "{int}", // one value is not a list
    "{}",
    "{.*}",
    "{[^/]+}", // no negation
    "{[0-9]*}", // a value is never empty
    "{[0-9]?}",
    "{[0-9]+?}",
    "{[0-9]{0}}",
    "{[0-9]{0,3}}",
    "{[0-9]{4,2}}",
    "{[z-a]+}",
    "{[a-\\d]+}",
    "{[!-~]+}", // the range takes in `%`
    "{[ -~]+}",
    "{[%]+}",
    "{[a/b]+}",
    "{[a-z]+|[0-9]+}", // one class, or a list of plain values
    "{(a|b)}",
    "{a|}",
    "{|a}",
    "{a|b c}",
    "{\\s+}",
    "{[\\s]+}",
    "{[é]+}",
    "{[0-9]+",
  ])("%s is not a constraint", (text) => {
    expect(paramConstraint(text)).toBeUndefined()
  })

  test("the parsed constraint cannot be changed", () => {
    const constraint = paramConstraint("{a|b}")
    expect(Object.isFrozen(constraint)).toBe(true)
    expect(Object.isFrozen(constraint?.oneOf)).toBe(true)
    expect(Object.isFrozen(constraint?.index)).toBe(true)
    expect(Object.getPrototypeOf(constraint?.index)).toBeNull()
    expect(constraint?.mask).toBe("0".repeat(128))
  })

  test("a class is a mask of the codes it holds, and a list an index of its values", () => {
    const digits = paramConstraint("{[0-9]+}")
    expect(digits?.mask).toBe(`${"0".repeat(48)}${"1".repeat(10)}${"0".repeat(70)}`)
    expect(digits?.index).toBeUndefined()
    expect(digits?.size).toBe(10)
    expect(paramConstraint("{\\w}")?.size).toBe(63)
    // A value a list names is looked up as a key; a name every object has is not one of them.
    const list = paramConstraint("{constructor|__proto__}")
    expect(Object.keys(list?.index ?? {}).sort()).toEqual(["__proto__", "constructor"])
    const router = routerOf("/k/:name{constructor|__proto__}", "/j/:name{a|b}")
    expect(hit(router, "/k/constructor")?.params).toEqual({ name: "constructor" })
    expect(hit(router, "/k/__proto__")?.params).toEqual({ name: "__proto__" })
    expect(hit(router, "/k/toString")).toBeUndefined()
    expect(hit(router, "/j/constructor")).toBeUndefined()
    expect(hit(router, "/j/__proto__")).toBeUndefined()
    expect(hit(router, "/j/toString")).toBeUndefined()
    expect(hit(router, "/j/a")?.params).toEqual({ name: "a" })
  })
})

describe("a constrained parameter in the router", () => {
  test("a class: only a value made of its characters matches", () => {
    const router = routerOf("/users/:id{[0-9]+}")
    expect(hit(router, "/users/12")).toEqual({
      payload: "/users/:id{[0-9]+}",
      params: { id: "12" },
    })
    expect(hit(router, "/users/0")?.params).toEqual({ id: "0" })
    expect(hit(router, "/users/12a")).toBeUndefined()
    expect(hit(router, "/users/a12")).toBeUndefined()
    expect(hit(router, "/users/-1")).toBeUndefined()
    expect(hit(router, "/users/١٢")).toBeUndefined() // digits outside ASCII
    expect(hit(router, "/users/")).toBeUndefined()
    expect(hit(router, "/users/12/x")).toBeUndefined()
  })

  test("a count bounds the length", () => {
    const router = routerOf("/c/:code{[A-Z]{2}}", "/p/:pin{\\d{4,6}}", "/t/:tag{[a-z]{3,}}")
    expect(hit(router, "/c/FR")?.params).toEqual({ code: "FR" })
    expect(hit(router, "/c/F")).toBeUndefined()
    expect(hit(router, "/c/FRA")).toBeUndefined()
    expect(hit(router, "/c/fr")).toBeUndefined()
    expect(hit(router, "/p/123")).toBeUndefined()
    expect(hit(router, "/p/1234")?.params).toEqual({ pin: "1234" })
    expect(hit(router, "/p/123456")?.params).toEqual({ pin: "123456" })
    expect(hit(router, "/p/1234567")).toBeUndefined()
    expect(hit(router, "/t/ab")).toBeUndefined()
    expect(hit(router, "/t/abcdefghij")?.params).toEqual({ tag: "abcdefghij" })
  })

  test("with no count the value is exactly one character", () => {
    const router = routerOf("/g/:grade{[a-f]}")
    expect(hit(router, "/g/c")?.params).toEqual({ grade: "c" })
    expect(hit(router, "/g/cc")).toBeUndefined()
    expect(hit(router, "/g/z")).toBeUndefined()
  })

  test("a list: only one of its values matches, whole and case-sensitive", () => {
    const router = routerOf("/img/:kind{thumb|full|raw}")
    expect(hit(router, "/img/thumb")?.params).toEqual({ kind: "thumb" })
    expect(hit(router, "/img/raw")?.params).toEqual({ kind: "raw" })
    expect(hit(router, "/img/thumbs")).toBeUndefined()
    expect(hit(router, "/img/thum")).toBeUndefined()
    expect(hit(router, "/img/Full")).toBeUndefined()
  })

  test("a value is tested as sent: a percent-escape never satisfies a constraint", () => {
    // `%32` is `2`. Accepting it would hand the handler a value other than the text that was tested
    // on every route whose class does not hold `%` - which is all of them.
    const router = routerOf("/users/:id{[0-9]+}", "/users/:name")
    expect(route(router, "/users/12")).toBe("/users/:id{[0-9]+}")
    // The router hands back the text as sent; the server decodes it for the handler.
    expect(hit(router, "/users/1%32")).toEqual({
      payload: "/users/:name",
      params: { name: "1%32" },
    })
    expect(hit(routerOf("/users/:id{[0-9]+}"), "/users/1%32")).toBeUndefined()
    expect(hit(routerOf("/l/:lang{en|fr}"), "/l/%65n")).toBeUndefined()
  })

  test("a request that fails the constraint goes on to the next candidate", () => {
    const router = routerOf(
      "/u/me",
      "/u/:id{[0-9]+}",
      "/u/:kind{admin|staff}",
      "/u/:name",
      "/u/*rest",
    )
    expect(route(router, "/u/me")).toBe("/u/me")
    expect(route(router, "/u/42")).toBe("/u/:id{[0-9]+}")
    expect(route(router, "/u/staff")).toBe("/u/:kind{admin|staff}")
    expect(route(router, "/u/ada")).toBe("/u/:name")
    expect(route(router, "/u/ada/x")).toBe("/u/*rest")
  })

  test("a deeper miss backs out of a constrained segment", () => {
    const router = routerOf("/o/:id{[0-9]+}/items", "/o/:slug/notes")
    expect(hit(router, "/o/7/items")?.params).toEqual({ id: "7" })
    expect(hit(router, "/o/7/notes")).toEqual({
      payload: "/o/:slug/notes",
      params: { slug: "7" },
    })
    expect(hit(router, "/o/7/other")).toBeUndefined()
  })

  test("which route wins does not depend on registration order", () => {
    const patterns = [
      "/u/:name",
      "/u/:word{\\w+}",
      "/u/:hex{[0-9a-f]+}",
      "/u/:id{[0-9]+}",
      "/u/:pair{[0-9]{2}}",
      "/u/:kind{admin|staff|42}",
      "/u/:one{admin|me}",
    ]
    const expected: Record<string, string> = {
      "/u/admin": "/u/:one{admin|me}", // the shorter list
      "/u/staff": "/u/:kind{admin|staff|42}",
      "/u/42": "/u/:kind{admin|staff|42}", // a list before any class
      "/u/43": "/u/:pair{[0-9]{2}}", // the tighter count
      "/u/431": "/u/:id{[0-9]+}", // digits are inside hex, and hex inside `\w`
      "/u/4f": "/u/:hex{[0-9a-f]+}",
      "/u/4g": "/u/:word{\\w+}",
      "/u/4-g": "/u/:name",
    }
    for (const order of orderings(patterns).filter((_, index) => index % 97 === 0)) {
      const router = routerOf(...order)
      for (const [path, winner] of Object.entries(expected)) {
        if (route(router, path) !== winner) {
          throw new Error(`[${order.join(", ")}] ${path} -> ${route(router, path)}, not ${winner}`)
        }
      }
    }
  })

  test("two spellings of one constraint are one route position", () => {
    const router = new Router<string>()
    router.add("GET", "/u/:id{\\d+}", "get")
    router.add("POST", "/u/:id{[0-9]+}", "post")
    expect(router.find("POST", "/u/5")).toMatchObject({ found: true, payload: "post" })
    expect(router.find("GET", "/u/5")).toMatchObject({ found: true, payload: "get" })
    expect(codeOf(() => router.add("GET", "/u/:id{[0-9]{1,}}", "again"))).toBe("DUPLICATE_ROUTE")
    expect(codeOf(() => router.add("PUT", "/u/:user{[0-9]+}", "renamed"))).toBe(
      "PARAM_NAME_CONFLICT",
    )
    // A different constraint is a different position, under any name.
    router.add("PUT", "/u/:user{[a-z]+}", "letters")
    expect(router.find("PUT", "/u/ada")).toMatchObject({ found: true, params: { user: "ada" } })
  })

  test("inside a segment with literal text", () => {
    const router = routerOf("/f/:name.:ext{png|jpg}", "/d/:y{\\d{4}}-:m{\\d{2}}", "/v:major{\\d+}")
    expect(hit(router, "/f/cat.png")?.params).toEqual({ name: "cat", ext: "png" })
    expect(hit(router, "/f/cat.gif")).toBeUndefined()
    expect(hit(router, "/f/cat.PNG")).toBeUndefined()
    expect(hit(router, "/d/2026-09")?.params).toEqual({ y: "2026", m: "09" })
    expect(hit(router, "/d/2026-9")).toBeUndefined()
    expect(hit(router, "/d/26-09")).toBeUndefined()
    expect(hit(router, "/v2")?.params).toEqual({ major: "2" })
    expect(hit(router, "/vx")).toBeUndefined()
  })

  test("literals are placed first and each value is then tested, with no second placement", () => {
    // The first `.` ends `name`, as it does with no constraint; `b.png` is then not in the list.
    const router = routerOf("/f/:name.:ext{png|jpg}")
    expect(hit(router, "/f/a.b.png")).toBeUndefined()
    // Two parameters that touch: the first takes one character, as it does with no constraint.
    const touching = routerOf("/t/:a{[0-9]+}:b{[a-z]+}")
    expect(hit(touching, "/t/1abc")?.params).toEqual({ a: "1", b: "abc" })
    expect(hit(touching, "/t/12abc")).toBeUndefined()
  })

  test("a constrained segment outranks a bare parameter and gives way to literal text", () => {
    const router = routerOf("/p/:id", "/p/:id{[0-9]+}", "/p/:id{[0-9]+}.json", "/p/7")
    expect(route(router, "/p/7")).toBe("/p/7")
    expect(route(router, "/p/8")).toBe("/p/:id{[0-9]+}")
    expect(route(router, "/p/8.json")).toBe("/p/:id{[0-9]+}.json")
    expect(route(router, "/p/x.json")).toBe("/p/:id")
  })

  test("braces that are not a constraint stay the literal text they were", () => {
    const router = routerOf("/x/:id{int}", "/y/:id{[0-9]*}")
    expect(hit(router, "/x/5{int}")?.params).toEqual({ id: "5" })
    expect(hit(router, "/x/5")).toBeUndefined()
    expect(hit(router, "/y/5{[0-9]*}")?.params).toEqual({ id: "5" })
    expect(hit(router, "/y/5")).toBeUndefined()
  })

  test("a parameter name is still checked, and still unique in the path", () => {
    expect(codeOf(() => compileRoutePattern("/a/:9{[0-9]+}"))).toBe("INVALID_PARAM_NAME")
    expect(codeOf(() => compileRoutePattern("/a/:__proto__{[0-9]+}"))).toBe("INVALID_PARAM_NAME")
    expect(codeOf(() => compileRoutePattern("/a/:id{[0-9]+}/:id{[a-z]+}"))).toBe("DUPLICATE_PARAM")
    expect(codeOf(() => compileRoutePattern("/a/:id{[0-9]+}-:id"))).toBe("DUPLICATE_PARAM")
  })

  test("the compiled segment carries the constraint", () => {
    const compiled = compileRoutePattern("/users/:id{[0-9]+}")
    expect(compiled.paramNames).toEqual(["id"])
    expect(compiled.segments[1]).toMatchObject({
      kind: "mixed",
      parts: [{ t: "param", name: "id", c: { source: "[0-9]+" } }],
    })
  })

  test("matchRoutePattern agrees with the router", () => {
    const cases: readonly (readonly [pattern: string, path: string])[] = [
      ["/users/:id{[0-9]+}", "/users/12"],
      ["/users/:id{[0-9]+}", "/users/12a"],
      ["/users/:id{[0-9]+}", "/users/1%32"],
      ["/f/:name.:ext{png|jpg}", "/f/cat.png"],
      ["/f/:name.:ext{png|jpg}", "/f/cat.gif"],
      ["/f/:name.:ext{png|jpg}", "/f/a.b.png"],
      ["/d/:y{\\d{4}}-:m{\\d{2}}", "/d/2026-09"],
      ["/d/:y{\\d{4}}-:m{\\d{2}}", "/d/2026-9"],
      ["/x/:id{int}", "/x/5{int}"],
    ]
    for (const [pattern, path] of cases) {
      const viaRouter = hit(routerOf(pattern), path)
      const direct = matchRoutePattern(compileRoutePattern(pattern), path)
      expect(direct.matched ? direct.params : undefined).toEqual(viaRouter?.params)
    }
  })

  test("a long value costs one pass", () => {
    // The value is the request's. 64 KB is the largest path a supported runtime hands over.
    const size = 64 * 1024
    const patterns = [
      "/f/:a{[0-9]+}",
      "/f/:a{[0-9]{1,70000}}",
      "/f/:a{[a-z]+}-:b{[a-z]+}-:c{[a-z]+}.json",
      "/f/:a{[a-z]+}:b{[a-z]+}:c{[a-z]+}",
      "/f/:a{aa|ab|ac}-:b{[a-]+}",
      "/f/:a{[0-9]+}?",
    ]
    const routers = patterns.map((pattern) => {
      const router = new Router<string>()
      for (const form of expandOptionalParams(pattern)) router.add("GET", form, form)
      return router
    })
    const compiled = patterns.map((pattern) =>
      compileRoutePattern(expandOptionalParams(pattern).at(-1) as string),
    )
    const paths: string[] = []
    for (const fill of ["0", "a", "-", "a-", "0a", "aa-", "%30"]) {
      const body = fill.repeat(Math.ceil(size / fill.length)).slice(0, size)
      for (const suffix of ["", ".json", "x", "-"]) paths.push(`/f/${body}${suffix}`)
    }
    let answered = 0
    const started = performance.now()
    for (const path of paths) {
      for (let i = 0; i < patterns.length; i++) {
        routers[i]?.find("GET", path)
        matchRoutePattern(compiled[i] as ReturnType<typeof compileRoutePattern>, path)
        answered += 2
      }
    }
    const elapsed = performance.now() - started
    expect(answered).toBe(paths.length * patterns.length * 2)
    expect(hit(routers[0] as Router<string>, `/f/${"0".repeat(size)}`)).toBeDefined()
    expect(elapsed).toBeLessThan(2000)
  })
})

describe("an optional constrained parameter", () => {
  test("the constraint stays on the long form", () => {
    expect(expandOptionalParams("/o/:id{[0-9]+}?")).toEqual(["/o", "/o/:id{[0-9]+}"])
    expect(expandOptionalParams("/d/:y{\\d{4}}?/:m{\\d{2}}?")).toEqual([
      "/d",
      "/d/:y{\\d{4}}",
      "/d/:y{\\d{4}}/:m{\\d{2}}",
    ])
    expect(expandOptionalParams("/l/:lang{en|fr}?/:page?")).toEqual([
      "/l",
      "/l/:lang{en|fr}",
      "/l/:lang{en|fr}/:page",
    ])
  })

  test("braces that are not a constraint do not make an optional parameter", () => {
    expect(expandOptionalParams("/o/:id{int}?")).toEqual(["/o/:id{int}?"])
    expect(expandOptionalParams("/o/:id{[0-9]+}x?")).toEqual(["/o/:id{[0-9]+}x?"])
  })

  test("served with and without the value, and never with a value the constraint refuses", async () => {
    const app = server().get("/o/:id{[0-9]+}?", (c) => ({ id: c.params.id ?? null }))
    const ask = async (path: string) => {
      const response = await app.fetch(new Request(`http://t${path}`))
      return response.status === 200 ? await response.json() : response.status
    }
    expect(await ask("/o")).toEqual({ id: null })
    expect(await ask("/o/5")).toEqual({ id: "5" })
    expect(await ask("/o/a")).toBe(404)
  })
})

describe("a constrained parameter on a server", () => {
  const app = server()
    .get("/users/:id{[0-9]+}", (c) => ({ route: "id", id: c.params.id }))
    .get("/users/:name", (c) => ({ route: "name", name: c.params.name }))
    .post("/users/:id{[0-9]+}", (c) => ({ route: "update", id: c.params.id }))
    .get("/files/:name.:ext{png|jpg}", (c) => ({ name: c.params.name, ext: c.params.ext }))
    .group("/v1", (v1) => v1.get("/items/:sku{[A-Z]{3}-[0-9]+}", () => ({ never: true })))

  const ask = async (method: string, path: string) => {
    const response = await app.fetch(new Request(`http://t${path}`, { method }))
    return {
      status: response.status,
      allow: response.headers.get("allow"),
      body: (await response.json()) as unknown,
    }
  }

  test("the value picks the route", async () => {
    expect((await ask("GET", "/users/42")).body).toEqual({ route: "id", id: "42" })
    expect((await ask("GET", "/users/ada")).body).toEqual({ route: "name", name: "ada" })
    expect((await ask("GET", "/users/4%32")).body).toEqual({ route: "name", name: "42" })
    expect((await ask("GET", "/files/cat.png")).body).toEqual({ name: "cat", ext: "png" })
    expect((await ask("GET", "/files/cat.gif")).status).toBe(404)
  })

  test("a method the constrained route lacks is answered for the route the value picked", async () => {
    expect((await ask("POST", "/users/42")).body).toEqual({ route: "update", id: "42" })
    const miss = await ask("DELETE", "/users/42")
    expect(miss.status).toBe(405)
    expect(miss.allow).toBe("GET, POST, HEAD")
    // A value the constraint refuses is the other route's request, and that route has no POST.
    const other = await ask("POST", "/users/ada")
    expect(other.status).toBe(405)
    expect(other.allow).toBe("GET, HEAD")
  })

  test("a constraint of more than one class is not a constraint", async () => {
    // The route is registered, with its braces as literal text.
    expect((await ask("GET", "/v1/items/ABC-12")).status).toBe(404)
  })
})

describe("route overlap with constraints", () => {
  const overlap = (left: string, right: string): string | undefined =>
    routePatternOverlap(left, right)

  test("classes with nothing in common do not overlap", () => {
    expect(overlap("/u/:id{[0-9]+}", "/u/:name{[a-z]+}")).toBeUndefined()
    expect(overlap("/u/:id{[0-9]+}", "/u/me")).toBeUndefined()
    expect(overlap("/u/:a{[0-9]{2}}", "/u/:b{[0-9]{3,}}")).toBeUndefined()
    expect(overlap("/u/:k{me|you}", "/u/:id{[0-9]+}")).toBeUndefined()
    expect(overlap("/u/:k{me|you}", "/u/them")).toBeUndefined()
    expect(overlap("/f/:n.:e{png|jpg}", "/f/:n.:e{gif|svg}")).toBeUndefined()
  })

  test("a shared value is returned as the witness, and it satisfies both", () => {
    const pairs: readonly (readonly [string, string])[] = [
      ["/u/:id{[0-9]+}", "/u/:name"],
      ["/u/:id{[0-9]+}", "/u/:hex{[0-9a-f]+}"],
      ["/u/:a{[0-9]{2,4}}", "/u/:b{[0-9]{3,}}"],
      ["/u/:k{me|you}", "/u/:w{[a-z]{3}}"],
      ["/u/:k{me|mine}", "/u/:j{min|mine}"],
      ["/u/:k{me|you}", "/u/me"],
      ["/u/:id{[0-9]+}", "/u/7"],
      ["/u/:id{[0-9]+}", "/u/*rest"],
      ["/f/:n.:e{png|jpg}", "/f/:file"],
      ["/o/:id{[0-9]+}?", "/o"],
      ["/o/:id{[0-9]+}?", "/o/:code{[0-9a-z]{2}}"],
    ]
    for (const [left, right] of pairs) {
      const witness = overlap(left, right)
      if (witness === undefined) throw new Error(`${left} and ${right}: no witness`)
      expect(overlap(right, left)).toBeDefined()
      for (const pattern of [left, right]) {
        const served = expandOptionalParams(pattern).some((form) => hit(routerOf(form), witness))
        if (!served) throw new Error(`${pattern} does not serve the witness ${witness}`)
      }
    }
    expect(overlap("/u/:a{[0-9]{2,4}}", "/u/:b{[0-9]{3,}}")).toHaveLength("/u/000".length)
    expect(overlap("/u/:k{me|mine}", "/u/:j{min|mine}")).toBe("/u/mine")
    expect(overlap("/u/:k{me|you}", "/u/:w{[a-z]{3}}")).toBe("/u/you")
  })

  test("two spellings of one constraint overlap", () => {
    expect(overlap("/u/:id{\\d+}", "/u/:id{[0-9]+}")).toBeDefined()
    expect(overlap("/u/:k{a|b}", "/u/:k{b|a}")).toBeDefined()
  })

  test("a count too large to walk fails closed", () => {
    expect(() => overlap("/u/:a{[0-9]{200000}}", "/u/:b{[0-9]{200001}}")).toThrow(
      RoutePatternOverlapLimitError,
    )
  })
})
