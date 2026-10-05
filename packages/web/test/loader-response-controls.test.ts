import { describe, expect, test } from "bun:test"
import { type NodeServeOutcome, nodeDirect } from "@nifrajs/core/node-direct"
import {
  createWebApp,
  enableDraft,
  type LoaderContext,
  type LoaderResponseControls,
  type Manifest,
  notFound,
  type RenderAdapter,
  redirect,
} from "../src/index.ts"
import { varyOnDataHeader } from "../src/internal/response-controls.ts"
import { MemoryCacheStore, openCacheChannel, withISR } from "../src/isr.ts"
import { DATA_HEADER, REDIRECT_HEADER, STATUS_HEADER } from "../src/router.ts"

const streamOf = (s: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

const stub: RenderAdapter = {
  renderToStream: (chain, props) =>
    streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
  hydrationHead: () => "",
}

type Loader = (ctx: LoaderContext) => unknown

interface PageOptions {
  readonly loader?: Loader
  readonly action?: Loader
  readonly layoutLoader?: Loader
  readonly gate?: boolean
  readonly revalidate?: number
  readonly errors?: boolean
}

const pageManifest = (options: PageOptions): Manifest =>
  ({
    routes: [
      {
        id: "page",
        pattern: "/page",
        layoutIds: options.layoutLoader === undefined ? [] : ["_layout"],
        ...(options.errors === true ? { errorIds: ["_error"] } : {}),
        file: "page.tsx",
        load: async () => ({
          default: "page",
          ...(options.loader === undefined ? {} : { loader: options.loader }),
          ...(options.action === undefined ? {} : { action: options.action }),
          ...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
        }),
      },
    ],
    layouts:
      options.layoutLoader === undefined
        ? {}
        : {
            _layout: {
              file: "_layout.tsx",
              load: async () => ({
                default: "layout",
                loader: options.layoutLoader,
                ...(options.gate === true ? { gate: true } : {}),
              }),
            },
          },
    ...(options.errors === true
      ? { errors: { _error: { file: "_error.tsx", load: async () => ({ default: "error" }) } } }
      : {}),
    notFound: { file: "_404.tsx", load: async () => ({ default: "the-404-page" }) },
  }) as Manifest

// The ISR channel is open, as under `withISR`, so these tests see what a cache wrapper is handed.
const appFor = (options: PageOptions, errors?: unknown[]) => {
  const app = createWebApp({
    adapter: stub,
    manifest: pageManifest(options),
    clientEntry: "/c.js",
    ...(errors === undefined ? {} : { onLoaderError: (err: unknown) => void errors.push(err) }),
  })
  openCacheChannel(app)
  return app
}

const doc = (app: { fetch(r: Request): Response | Promise<Response> }) =>
  app.fetch(new Request("http://x/page"))
const data = (app: { fetch(r: Request): Response | Promise<Response> }) =>
  app.fetch(new Request("http://x/page", { headers: { [DATA_HEADER]: "1" } }))
const post = (app: { fetch(r: Request): Response | Promise<Response> }, asData = false) =>
  app.fetch(
    new Request("http://x/page", {
      method: "POST",
      body: new URLSearchParams({ name: "Ada" }),
      ...(asData ? { headers: { [DATA_HEADER]: "1" } } : {}),
    }),
  )

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

describe("layout loader promise compatibility", () => {
  test("assimilates a thenable without reading its then getter twice", async () => {
    let reads = 0
    const app = appFor({
      layoutLoader: () => ({
        // biome-ignore lint/suspicious/noThenProperty: exercise await's deliberate thenable assimilation.
        get then() {
          reads++
          return (resolve: (value: unknown) => void) => resolve({ from: "thenable" })
        },
      }),
    })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"__NIFRA_LAYOUT_DATA__":[{"from":"thenable"}]')
    expect(reads).toBe(1)
  })

  test("awaits a promise from another realm", async () => {
    const { runInNewContext } = await import("node:vm")
    const foreign: unknown = runInNewContext('Promise.resolve({ from: "foreign" })')
    expect(foreign instanceof Promise).toBe(false)
    const app = appFor({ layoutLoader: () => foreign })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"__NIFRA_LAYOUT_DATA__":[{"from":"foreign"}]')
  })

  test("assimilates a proxy thenable whose then property is absent from has", async () => {
    const value = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (key !== "then") return Reflect.get(target, key, receiver)
          return function (this: unknown, resolve: (data: unknown) => void) {
            expect(this).toBe(value)
            resolve({ from: "proxy" })
          }
        },
      },
    )
    expect("then" in value).toBe(false)
    const app = appFor({ layoutLoader: () => value })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"__NIFRA_LAYOUT_DATA__":[{"from":"proxy"}]')
  })

  test("does not inspect a layout thenable's prototype", async () => {
    const value = new Proxy(
      {
        // biome-ignore lint/suspicious/noThenProperty: exercise await's deliberate thenable assimilation.
        then(resolve: (data: unknown) => void) {
          resolve({ from: "opaque" })
        },
      },
      {
        getPrototypeOf() {
          throw new Error("prototype inspection is forbidden")
        },
      },
    )
    const app = appFor({ layoutLoader: () => value })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"__NIFRA_LAYOUT_DATA__":[{"from":"opaque"}]')
  })
})

describe("ctx.set.headers", () => {
  test("a loader's headers reach the document, lower-cased, and the document varies on the data channel", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.headers["Cache-Control"] = "public, max-age=60"
        ctx.set.headers["x-robots-tag"] = "noindex"
        return { ok: true }
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("public, max-age=60")
    expect(res.headers.get("x-robots-tag")).toBe("noindex")
    expect(res.headers.get("vary")).toBe(DATA_HEADER)
    expect(await res.text()).toContain('chain=1:{"ok":true}')
  })

  test("a loader that writes nothing leaves the document's headers alone", async () => {
    const res = await doc(appFor({ loader: () => ({ ok: true }) }))
    expect(res.headers.get("vary")).toBeNull()
    expect(res.headers.get("cache-control")).toBeNull()
  })

  test("a loader's `vary` is kept and extended", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.headers.vary = "accept-language"
        return null
      },
    })
    expect((await doc(app)).headers.get("vary")).toBe(`accept-language, ${DATA_HEADER}`)
  })

  test("a navigation data response is never storable and never carries the loader's headers", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.headers["cache-control"] = "public, max-age=31536000"
        ctx.set.headers["x-robots-tag"] = "noindex"
        return { ok: true }
      },
    })
    const res = await data(app)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    // Same URL as the document: a stored copy would be served to a visitor asking for the page.
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("vary")).toBe(DATA_HEADER)
    expect(res.headers.get("x-robots-tag")).toBeNull()
    expect(await res.json()).toEqual({ ok: true })
  })

  test("a data response is unstorable even when no loader touched `ctx.set`", async () => {
    const res = await data(appFor({ loader: () => ({ ok: true }) }))
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("vary")).toBe(DATA_HEADER)
  })

  test("the page loader wins a name over its layout, whichever loader settles last", async () => {
    const app = appFor({
      // The layout settles AFTER the page loader; a shared record would let it win the race.
      layoutLoader: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        ctx.set.headers["cache-control"] = "public, max-age=1"
        ctx.set.headers["x-from-layout"] = "1"
        return null
      },
      loader: (ctx) => {
        ctx.set.headers["cache-control"] = "public, max-age=2"
        return null
      },
    })
    const res = await doc(app)
    expect(res.headers.get("cache-control")).toBe("public, max-age=2")
    expect(res.headers.get("x-from-layout")).toBe("1")
  })

  test("headers are not applied to a redirect, a status page, or an error page", async () => {
    const written = (ctx: LoaderContext) => {
      ctx.set.headers["cache-control"] = "public, max-age=60"
      ctx.set.headers["x-page"] = "1"
    }
    const redirected = await doc(
      appFor({
        loader: (ctx) => {
          written(ctx)
          throw redirect("/login")
        },
      }),
    )
    expect(redirected.status).toBe(303)
    expect(redirected.headers.get("x-page")).toBeNull()
    expect(redirected.headers.get("cache-control")).toBeNull()

    const missing = await doc(
      appFor({
        loader: (ctx) => {
          written(ctx)
          notFound()
        },
      }),
    )
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-page")).toBeNull()
    expect(missing.headers.get("cache-control")).toBeNull()

    const failed = await doc(
      appFor({
        errors: true,
        loader: (ctx) => {
          written(ctx)
          throw new Error("boom")
        },
      }),
    )
    expect(failed.status).toBe(500)
    expect(failed.headers.get("x-page")).toBeNull()
    expect(failed.headers.get("cache-control")).toBeNull()
  })
})

describe("ctx.set.headers refuses what a loader must not write", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["content-type", "application/json"],
    ["Content-Type", "text/plain"],
    ["content-length", "1"],
    ["transfer-encoding", "chunked"],
    ["connection", "close"],
    ["set-cookie", "session=1"],
    ["location", "https://evil.example"],
    [REDIRECT_HEADER, "https://evil.example"],
    [STATUS_HEADER, "404"],
    ["x-nifra-isr-revalidate", "31536000"],
    ["X-Nifra-Isr-Tags", "everything"],
  ]
  for (const [name, value] of refused) {
    test(`"${name}" fails the request instead of being sent`, async () => {
      const errors: unknown[] = []
      const app = appFor(
        {
          errors: true,
          loader: (ctx) => {
            ctx.set.headers[name] = value
            return { ok: true }
          },
        },
        errors,
      )
      for (const res of [await doc(app), await data(app)]) {
        expect(res.status).toBe(500)
        expect(res.headers.get("location")).toBeNull()
        expect(res.headers.get(REDIRECT_HEADER)).toBeNull()
        expect(res.headers.get(STATUS_HEADER)).toBeNull()
        expect(res.headers.get("x-nifra-isr-revalidate")).toBeNull()
        expect(res.headers.getSetCookie()).toEqual([])
        await res.body?.cancel()
      }
      expect(errors).toHaveLength(2)
      expect(messageOf(errors[0])).toContain(`"${name.toLowerCase()}" is reserved`)
    })
  }

  const unsendable: ReadonlyArray<readonly [string, string, string]> = [
    ["a line break", "x-note", "ok\r\nset-cookie: session=stolen"],
    ["a bare line feed", "x-note", "ok\nx-injected: 1"],
    ["a NUL", "x-note", "a\u0000b"],
    ["a character outside Latin-1", "x-note", "café ☃"],
  ]
  for (const [label, name, value] of unsendable) {
    test(`a value with ${label} fails the request and is not echoed into the error`, async () => {
      const errors: unknown[] = []
      const app = appFor(
        {
          errors: true,
          loader: (ctx) => {
            ctx.set.headers[name] = value
            return null
          },
        },
        errors,
      )
      const res = await doc(app)
      expect(res.status).toBe(500)
      expect(res.headers.get(name)).toBeNull()
      expect(res.headers.get("x-injected")).toBeNull()
      expect(res.headers.getSetCookie()).toEqual([])
      expect(errors).toHaveLength(1)
      expect(messageOf(errors[0])).toContain(`the value of "${name}"`)
      expect(messageOf(errors[0])).not.toContain("stolen")
      expect(messageOf(errors[0])).not.toContain("caf")
    })
  }

  test("a Latin-1 value is sent", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.headers["x-note"] = "café"
        return null
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-note")).toBe("café")
  })

  for (const name of ["x note", "x-note:", "", "x\r\nset-cookie", "café"]) {
    test(`the name ${JSON.stringify(name)} fails the request`, async () => {
      const errors: unknown[] = []
      const app = appFor(
        {
          errors: true,
          loader: (ctx) => {
            ctx.set.headers[name] = "1"
            return null
          },
        },
        errors,
      )
      const res = await doc(app)
      expect(res.status).toBe(500)
      expect(res.headers.getSetCookie()).toEqual([])
      expect(messageOf(errors[0])).toContain("is not a valid header name")
    })
  }

  test("a non-string value fails the request", async () => {
    const errors: unknown[] = []
    const app = appFor(
      {
        errors: true,
        loader: (ctx) => {
          ;(ctx.set.headers as Record<string, unknown>)["x-count"] = 3
          return null
        },
      },
      errors,
    )
    expect((await doc(app)).status).toBe(500)
    expect(messageOf(errors[0])).toContain('the value of "x-count" must be a string')
  })
})

describe("ctx.set.cookie", () => {
  test("a loader's cookie rides the document with the secure defaults, and the document turns private", async () => {
    const app = appFor({
      revalidate: 60,
      loader: (ctx) => {
        ctx.set.headers["cache-control"] = "public, max-age=60"
        ctx.set.cookie("bucket", "b")
        return null
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()).toEqual(["bucket=b; Path=/; HttpOnly; Secure; SameSite=Lax"])
    // One visitor's response: never public, and never offered to the ISR store.
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("x-nifra-isr-revalidate")).toBeNull()
  })

  test("without a cookie the same page advertises its ISR freshness", async () => {
    const res = await doc(appFor({ revalidate: 60, loader: () => null }))
    expect(res.headers.get("x-nifra-isr-revalidate")).toBe("60")
  })

  test("a cookie rides a navigation data response", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.cookie("bucket", "b", { httpOnly: false, maxAge: 60 })
        return { ok: true }
      },
    })
    const res = await data(app)
    expect(res.headers.getSetCookie()).toEqual([
      "bucket=b; Max-Age=60; Path=/; Secure; SameSite=Lax",
    ])
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("deleteCookie queues an expiry and also makes the document private", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.deleteCookie("bucket")
        return null
      },
    })
    const res = await doc(app)
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toContain("bucket=;")
    expect(cookies[0]).toContain("Max-Age=0")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a cookie rides a redirect, which is then not storable either", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.cookie("seen", "1")
        throw redirect("/next", { status: 301 })
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/next")
    expect(res.headers.getSetCookie()).toHaveLength(1)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a cookie queued before notFound() makes the status page private, whatever it declared", async () => {
    const loader: Loader = (ctx) => {
      ctx.set.cookie("seen", "1")
      notFound({ headers: { "cache-control": "public, max-age=600" } })
    }
    const res = await doc(appFor({ loader }))
    expect(res.status).toBe(404)
    expect(res.headers.getSetCookie()).toHaveLength(1)
    expect(res.headers.get("cache-control")).toBe("private, no-store")

    const asData = await data(appFor({ loader }))
    expect(asData.status).toBe(404)
    expect(asData.headers.get(STATUS_HEADER)).toBe("404")
    expect(asData.headers.getSetCookie()).toHaveLength(1)
    expect(asData.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a cookie queued before a loader error still rides the error page", async () => {
    const app = appFor({
      errors: true,
      loader: (ctx) => {
        ctx.set.cookie("seen", "1")
        throw new Error("boom")
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(500)
    expect(res.headers.getSetCookie()).toHaveLength(1)
  })

  test("an invalid cookie fails in the loader, at the call", async () => {
    let thrown: unknown
    const app = appFor({
      errors: true,
      loader: (ctx) => {
        try {
          ctx.set.cookie("bad name", "1")
        } catch (err) {
          thrown = err
        }
        return null
      },
    })
    const res = await doc(app)
    expect(messageOf(thrown)).toContain("invalid cookie name")
    expect(res.headers.getSetCookie()).toEqual([])
  })

  test("a layout gate's cookie rides the page", async () => {
    const app = appFor({
      gate: true,
      layoutLoader: (ctx) => {
        ctx.set.cookie("csrf", "t")
        return null
      },
      loader: () => ({ ok: true }),
    })
    const res = await doc(app)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie()).toHaveLength(1)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })

  test("enableDraft takes a loader or action context", async () => {
    const app = appFor({
      action: async (ctx) => {
        await enableDraft(ctx, "a-draft-secret-of-enough-length!")
        return redirect("/page")
      },
    })
    const res = await post(app)
    expect(res.status).toBe(303)
    expect(res.headers.getSetCookie()).toHaveLength(1)
  })
})

describe("status-page headers", () => {
  test("a status page with headers varies on the data channel; its data twin is never storable", async () => {
    const loader: Loader = () => {
      notFound({ headers: { "cache-control": "public, max-age=600" } })
    }
    const page = await doc(appFor({ loader }))
    expect(page.status).toBe(404)
    expect(page.headers.get("cache-control")).toBe("public, max-age=600")
    expect(page.headers.get("vary")).toBe(DATA_HEADER)

    // An empty-bodied 404 stored under the page's URL would blank the status page for everyone.
    const twin = await data(appFor({ loader }))
    expect(twin.status).toBe(404)
    expect(twin.headers.get("cache-control")).toBe("private, no-store")
    expect(twin.headers.get("vary")).toBe(DATA_HEADER)
  })

  test("a status page without headers is untouched", async () => {
    const page = await doc(
      appFor({
        loader: () => {
          notFound()
        },
      }),
    )
    expect(page.status).toBe(404)
    expect(page.headers.get("vary")).toBeNull()
    expect(page.headers.get("cache-control")).toBeNull()
  })
})

describe("ctx.set in an action", () => {
  test("a login action sets its cookie and redirects, on a form post and on a fetch submit", async () => {
    const action: Loader = (ctx) => {
      ctx.set.cookie("session", "s1")
      return redirect("/home")
    }
    const form = await post(appFor({ action }))
    expect(form.status).toBe(303)
    expect(form.headers.get("location")).toBe("/home")
    expect(form.headers.getSetCookie()).toEqual([
      "session=s1; Path=/; HttpOnly; Secure; SameSite=Lax",
    ])
    expect(form.headers.get("cache-control")).toBe("private, no-store")

    const fetched = await post(appFor({ action }), true)
    expect(fetched.status).toBe(204)
    expect(fetched.headers.get(REDIRECT_HEADER)).toBe("/home")
    expect(fetched.headers.getSetCookie()).toHaveLength(1)
  })

  test("an action's headers reach the re-rendered document and win over the page loader's", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.headers["x-writer"] = "loader"
        ctx.set.headers["x-loader"] = "1"
        return null
      },
      action: (ctx) => {
        ctx.set.headers["x-writer"] = "action"
        return { saved: true }
      },
    })
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-writer")).toBe("action")
    expect(res.headers.get("x-loader")).toBe("1")
  })

  test("an action's data response carries its cookie, not its headers", async () => {
    const app = appFor({
      action: (ctx) => {
        ctx.set.headers["x-writer"] = "action"
        ctx.set.cookie("flash", "saved")
        return { saved: true }
      },
    })
    const res = await post(app, true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ saved: true })
    expect(res.headers.get("x-writer")).toBeNull()
    expect(res.headers.getSetCookie()).toHaveLength(1)
  })

  test("a refused header fails an action's data response too", async () => {
    const app = appFor({
      action: (ctx) => {
        ctx.set.headers[REDIRECT_HEADER] = "https://evil.example"
        return { saved: true }
      },
    })
    const res = await post(app, true)
    expect(res.status).toBe(500)
    expect(res.headers.get(REDIRECT_HEADER)).toBeNull()
  })

  test("a gate's cookie rides the action's response", async () => {
    const app = appFor({
      gate: true,
      layoutLoader: (ctx) => {
        ctx.set.cookie("csrf", "t")
        return null
      },
      action: () => ({ saved: true }),
    })
    const res = await post(app, true)
    expect(res.headers.getSetCookie()).toHaveLength(1)
  })
})

describe("ctx.set after the response is committed", () => {
  test("a late write throws instead of vanishing", async () => {
    let late: LoaderResponseControls | undefined
    let record: Record<string, string> | undefined
    const app = appFor({
      loader: (ctx) => {
        late = ctx.set
        record = ctx.set.headers
        record["x-early"] = "1"
        return null
      },
    })
    const res = await doc(app)
    expect(res.headers.get("x-early")).toBe("1")
    await res.text()

    const set = late as LoaderResponseControls
    expect(() => set.cookie("late", "1")).toThrow(/after the response was committed/)
    expect(() => set.deleteCookie("late")).toThrow(/after the response was committed/)
    expect(() => set.headers).toThrow(/after the response was committed/)
    // A record captured earlier is frozen, so a write through it cannot look like it worked.
    expect(() => {
      ;(record as Record<string, string>)["x-late"] = "1"
    }).toThrow(TypeError)
  })

  test("a redirect, a status page, and an error page close the controls too", async () => {
    const outcomes: Array<() => unknown> = [
      () => {
        throw redirect("/next")
      },
      () => notFound(),
      () => {
        throw new Error("boom")
      },
    ]
    for (const outcome of outcomes) {
      let late: LoaderResponseControls | undefined
      const app = appFor({
        errors: true,
        loader: (ctx) => {
          late = ctx.set
          return outcome()
        },
      })
      await (await doc(app)).body?.cancel()
      expect(() => (late as LoaderResponseControls).cookie("late", "1")).toThrow(
        /after the response was committed/,
      )
    }
  })
})

describe("ISR with loader headers", () => {
  test("a page whose loader writes headers is still stored, and a hit replays them", async () => {
    let renders = 0
    const app = appFor({
      revalidate: 60,
      loader: (ctx) => {
        renders++
        ctx.set.headers["x-robots-tag"] = "noindex"
        return null
      },
    })
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    const miss = await handler(new Request("http://x/page"))
    expect(miss.headers.get("x-nifra-isr")).toBe("miss")
    await miss.text()
    const hit = await handler(new Request("http://x/page"))
    expect(hit.headers.get("x-nifra-isr")).toBe("hit")
    expect(hit.headers.get("x-robots-tag")).toBe("noindex")
    expect(hit.headers.get("vary")).toBe(DATA_HEADER)
    expect(renders).toBe(1)

    // The stored document is never the answer to a data request for the same URL.
    const asData = await handler(new Request("http://x/page", { headers: { [DATA_HEADER]: "1" } }))
    expect(asData.headers.get("x-nifra-isr")).toBeNull()
    expect(asData.headers.get("content-type")).toContain("application/json")
  })

  test("a loader's `vary` on a real request header still keeps the page out of the URL-keyed store", async () => {
    const app = appFor({
      revalidate: 60,
      loader: (ctx) => {
        ctx.set.headers.vary = "accept-language"
        return null
      },
    })
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    await (await handler(new Request("http://x/page"))).text()
    const second = await handler(new Request("http://x/page"))
    expect(second.headers.get("x-nifra-isr")).not.toBe("hit")
  })

  test("a page that sets a cookie is never stored", async () => {
    let renders = 0
    const app = appFor({
      revalidate: 60,
      loader: (ctx) => {
        renders++
        ctx.set.cookie("bucket", "b")
        return null
      },
    })
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    await (await handler(new Request("http://x/page"))).text()
    const second = await handler(new Request("http://x/page"))
    expect(second.headers.get("x-nifra-isr")).not.toBe("hit")
    expect(second.headers.getSetCookie()).toHaveLength(1)
    expect(renders).toBe(2)
  })

  test("a loader's `cache-control: no-store` opts the page out", async () => {
    let renders = 0
    const app = appFor({
      revalidate: 60,
      loader: (ctx) => {
        renders++
        ctx.set.headers["cache-control"] = "no-store"
        return null
      },
    })
    const handler = withISR(app, { store: new MemoryCacheStore(), revalidate: 60, now: () => 0 })
    await (await handler(new Request("http://x/page"))).text()
    await (await handler(new Request("http://x/page"))).text()
    expect(renders).toBe(2)
  })
})

describe("varyOnDataHeader", () => {
  test("adds the data header once, and leaves `*` alone", () => {
    expect(varyOnDataHeader(undefined)).toBe(DATA_HEADER)
    expect(varyOnDataHeader(null)).toBe(DATA_HEADER)
    expect(varyOnDataHeader("")).toBe(DATA_HEADER)
    expect(varyOnDataHeader(" , ")).toBe(DATA_HEADER)
    expect(varyOnDataHeader("accept-language")).toBe(`accept-language, ${DATA_HEADER}`)
    expect(varyOnDataHeader("Accept, X-Nifra-Data")).toBe("Accept, X-Nifra-Data")
    expect(varyOnDataHeader("*")).toBe("*")
  })
})

describe("the Node direct-body lane", () => {
  // A sync adapter renders a buffered page, which the Node adapter writes without building a Response.
  const buffered: RenderAdapter = {
    renderToString: (chain, props) => `<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`,
    renderToStream: (chain, props) =>
      streamOf(`<p>chain=${chain.length}:${JSON.stringify(props.data)}</p>`),
    hydrationHead: () => "",
  }
  // What the Node adapter puts on the wire for an outcome, whichever lane produced it.
  const sentByNode = (outcome: NodeServeOutcome): { status: number; headers: Headers } => {
    if (outcome.kind === "response") {
      return { status: outcome.response.status, headers: outcome.response.headers }
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(outcome.headers ?? {})) {
      for (const item of typeof value === "string" ? [value] : value) headers.append(name, item)
    }
    if (outcome.kind === "json") {
      for (const cookie of outcome.cookies ?? []) headers.append("set-cookie", cookie)
    }
    return { status: outcome.status, headers }
  }
  const nodeApp = (options: PageOptions) =>
    createWebApp({ adapter: buffered, manifest: pageManifest(options), clientEntry: "/c.js" }).use(
      nodeDirect(),
    )

  test("carries the loader's headers and cookies on the buffered document", async () => {
    const app = nodeApp({
      loader: (ctx) => {
        ctx.set.headers["x-robots-tag"] = "noindex"
        ctx.set.cookie("sid", "abc")
        return { ok: true }
      },
    })
    const outcome = await app.resolveNode(new Request("http://x/page"))
    expect(outcome.kind).toBe("body")
    if (outcome.kind !== "body") throw new Error("unreachable")
    expect(outcome.status).toBe(200)
    expect(outcome.headers?.["x-robots-tag"]).toBe("noindex")
    expect(outcome.headers?.["cache-control"]).toBe("private, no-store")
    expect(outcome.headers?.vary).toBe(DATA_HEADER)
    expect(outcome.headers?.["set-cookie"]).toEqual([
      "sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
    ])
  })

  test("a redirect that queued a cookie carries it and is unstorable", async () => {
    const app = nodeApp({
      loader: (ctx) => {
        ctx.set.cookie("sid", "abc")
        throw redirect("/next", { status: 301 })
      },
    })
    const sent = sentByNode(await app.resolveNode(new Request("http://x/page")))
    expect(sent.status).toBe(301)
    expect(sent.headers.get("location")).toBe("/next")
    expect(sent.headers.get("cache-control")).toBe("private, no-store")
    expect(sent.headers.getSetCookie()).toEqual(["sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax"])
  })
})

describe("a queued cookie keeps every outcome out of shared caches", () => {
  const COOKIE = "sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax"

  test("a thrown hand-built Response that asked for public caching", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.cookie("sid", "abc")
        throw new Response("gone", {
          status: 404,
          headers: { "cache-control": "public, max-age=60" },
        })
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("gone")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.getSetCookie()).toEqual([COOKIE])
  })

  test("a returned Response whose headers are immutable", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.cookie("sid", "abc")
        return Response.redirect("http://x/next", 301)
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("http://x/next")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.getSetCookie()).toEqual([COOKIE])
  })

  test("a redirect that names its own cache-control, in any casing", async () => {
    const app = appFor({
      loader: (ctx) => {
        ctx.set.cookie("sid", "abc")
        throw redirect("/next", {
          status: 301,
          headers: { "Cache-Control": "public, max-age=60", "x-reason": "moved" },
        })
      },
    })
    const res = await doc(app)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("/next")
    expect(res.headers.get("x-reason")).toBe("moved")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.getSetCookie()).toEqual([COOKIE])
  })

  test("an action's hand-built Response", async () => {
    const app = appFor({
      action: (ctx) => {
        ctx.set.cookie("sid", "abc")
        return new Response("done", { headers: { "cache-control": "public, max-age=60" } })
      },
    })
    const res = await post(app)
    expect(await res.text()).toBe("done")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.getSetCookie()).toEqual([COOKIE])
  })

  test("the error page", async () => {
    const app = appFor(
      {
        errors: true,
        loader: (ctx) => {
          ctx.set.cookie("sid", "abc")
          throw new Error("boom")
        },
      },
      [],
    )
    const res = await doc(app)
    expect(res.status).toBe(500)
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.getSetCookie()).toEqual([COOKIE])
  })

  test("without a cookie a hand-built Response keeps the caching it asked for", async () => {
    const app = appFor({
      loader: () => new Response("ok", { headers: { "cache-control": "public, max-age=60" } }),
    })
    const res = await doc(app)
    expect(res.headers.get("cache-control")).toBe("public, max-age=60")
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe("an action's navigation data response", () => {
  test("is unstorable and keeps the revalidation paths", async () => {
    const app = appFor({ action: () => ({ saved: true }) })
    const res = await post(app, true)
    expect(await res.json()).toEqual({ saved: true })
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    expect(res.headers.get("vary")).toBe(DATA_HEADER)
  })
})
