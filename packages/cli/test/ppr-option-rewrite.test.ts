import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { getSourceRewrite } from "../src/source-rewrites.ts"

const rewrite = (text: string, file = "app.ts") => {
  const pprOption = getSourceRewrite("ppr-option")
  if (pprOption === undefined) throw new Error("the ppr-option rewrite is registered")
  return pprOption.rewrite(ts, file, text)
}

const MOVED =
  "experimental.ppr is now ppr: pass it beside the other createWebApp options and remove `experimental`"

describe("ppr-option rewrite", () => {
  test("experimental: { ppr } becomes a top-level ppr, whatever the value", () => {
    const result = rewrite(`import { createWebApp } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"

export const app = createWebApp({
  adapter,
  manifest,
  experimental: { ppr: partialPrerendering({ shellChecks, origin: "https://shop.example" }) },
})
`)
    expect(result.text).toBe(`import { createWebApp } from "@nifrajs/web"
import { partialPrerendering } from "@nifrajs/web/ppr"

export const app = createWebApp({
  adapter,
  manifest,
  ppr: partialPrerendering({ shellChecks, origin: "https://shop.example" }),
})
`)
    expect(result.count).toBe(1)
    expect(result.manual).toEqual([])
  })

  test("a shorthand ppr and a multi-line value keep their text", () => {
    const result = rewrite(`import { createWebApp } from "@nifrajs/web"

export const a = createWebApp({ experimental: { ppr }, adapter })
export const b = createWebApp({
  experimental: {
    ppr: partialPrerendering({
      shellChecks,
    }),
  },
  adapter,
})
`)
    expect(result.text).toBe(`import { createWebApp } from "@nifrajs/web"

export const a = createWebApp({ ppr, adapter })
export const b = createWebApp({
  ppr: partialPrerendering({
      shellChecks,
    }),
  adapter,
})
`)
    expect(result.count).toBe(2)
    expect(result.manual).toEqual([])
  })

  test("createWebApp reached through an alias or a namespace import is found", () => {
    const result = rewrite(`import { createWebApp as makeApp } from "@nifrajs/web"
import * as web from "@nifrajs/web"

export const a = makeApp({ experimental: { ppr: setup } })
export const b = web.createWebApp({ experimental: { ppr: setup } })
`)
    expect(result.text).toBe(`import { createWebApp as makeApp } from "@nifrajs/web"
import * as web from "@nifrajs/web"

export const a = makeApp({ ppr: setup })
export const b = web.createWebApp({ ppr: setup })
`)
    expect(result.count).toBe(2)
  })

  test("a shape it cannot move whole is listed by line and left alone", () => {
    const source = `import { createWebApp } from "@nifrajs/web"

const options = { experimental: { ppr: setup } }
export const a = createWebApp({ experimental: { ppr: setup, other: 1 } })
export const b = createWebApp({ experimental: flags })
export const c = createWebApp({ ppr: first, experimental: { ppr: second } })
export const d = createWebApp({ ...base, experimental: { ...extra } })
`
    const result = rewrite(source)
    expect(result.text).toBe(source)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      { line: 3, reason: MOVED },
      { line: 4, reason: MOVED },
      { line: 5, reason: MOVED },
      { line: 6, reason: MOVED },
      { line: 7, reason: MOVED },
    ])
  })

  test("a createWebApp from another package, and an experimental key without ppr, are left alone", () => {
    const source = `import { createWebApp } from "other-framework"

export const a = createWebApp({ experimental: { ppr: setup } })
export const b = { experimental: { flag: true } }
`
    const result = rewrite(source)
    expect(result.text).toBe(source)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([{ line: 3, reason: MOVED }])
  })

  test("a call with no options literal, or none moved, is left alone", () => {
    const source = `import { createWebApp } from "@nifrajs/web"

export const a = createWebApp()
export const b = createWebApp(config)
export const c = createWebApp({ adapter, ppr: setup })
`
    const result = rewrite(source)
    expect(result.text).toBe(source)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([])
  })

  test("another function from @nifrajs/web is not createWebApp, and default or bare imports are skipped", () => {
    const source = `import web from "@nifrajs/web"
import "@nifrajs/web"
import { createWebApp, renderApp } from "@nifrajs/web"

export const a = renderApp({ experimental: { ppr: setup } })
export const b = createWebApp({ experimental: { ppr: setup } })
`
    const result = rewrite(source)
    expect(result.text).toBe(`import web from "@nifrajs/web"
import "@nifrajs/web"
import { createWebApp, renderApp } from "@nifrajs/web"

export const a = renderApp({ experimental: { ppr: setup } })
export const b = createWebApp({ ppr: setup })
`)
    expect(result.count).toBe(1)
    expect(result.manual).toEqual([{ line: 5, reason: MOVED }])
  })

  test("options spread into the call are the user's to move, whichever side the spread is on", () => {
    const source = `import { createWebApp } from "@nifrajs/web"

export const a = createWebApp({ ...defaults, experimental: { ppr: setup } })
export const b = createWebApp({ experimental: { ppr: setup }, ...defaults })
`
    const result = rewrite(source)
    expect(result.text).toBe(source)
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      { line: 3, reason: MOVED },
      { line: 4, reason: MOVED },
    ])
  })

  test("only text that mentions experimental and createWebApp is parsed, with or without ppr", () => {
    const pprOption = getSourceRewrite("ppr-option")
    expect(pprOption?.mentions("export const ppr = 1")).toBe(false)
    expect(pprOption?.mentions("const experimental = true")).toBe(false)
    expect(pprOption?.mentions("createWebApp({ ppr })")).toBe(false)
    expect(pprOption?.mentions("createWebApp({ experimental: flags })")).toBe(true)
    expect(pprOption?.mentions("createWebApp({ experimental: { ppr } })")).toBe(true)
  })
})
