import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { language, pickLanguage } from "../src/index.ts"

describe("language()", () => {
  const supported = ["en", "fr-FR", "pt-BR"] as const

  test("pickLanguage handles exact, base, wildcard, q, and default matches", () => {
    expect(pickLanguage("fr-FR, en;q=0.8", supported, "en")).toEqual({
      language: "fr-FR",
      matched: "exact",
    })
    expect(pickLanguage("fr-CA, en;q=0.8", supported, "en")).toEqual({
      language: "fr-FR",
      matched: "base",
    })
    expect(pickLanguage("de;q=0.9, pt;q=0.8", supported, "en")).toEqual({
      language: "pt-BR",
      matched: "base",
    })
    expect(pickLanguage("*;q=0.5", supported, "en")).toEqual({
      language: "en",
      matched: "wildcard",
    })
    expect(pickLanguage(null, supported, "en")).toEqual({ language: "en", matched: "default" })
  })

  test("derives c.language and emits Content-Language", async () => {
    const app = server()
      .use(language({ supported, defaultLanguage: "en" }))
      .get("/", (c) => ({ language: c.language, match: c.languageMatch.matched }))

    const res = await app.fetch(new Request("http://x/", { headers: { "accept-language": "pt" } }))
    expect(res.headers.get("content-language")).toBe("pt-BR")
    expect(await res.json()).toEqual({ language: "pt-BR", match: "base" })
  })

  test("respects an existing Content-Language and can disable header emission", async () => {
    const existing = server()
      .use(language({ supported, defaultLanguage: "en" }))
      .get("/", () => new Response("ok", { headers: { "content-language": "de" } }))
    expect((await existing.fetch(new Request("http://x/"))).headers.get("content-language")).toBe(
      "de",
    )

    const disabled = server()
      .use(language({ supported, defaultLanguage: "en", header: false }))
      .get("/", (c) => c.language)
    expect(
      (await disabled.fetch(new Request("http://x/"))).headers.get("content-language"),
    ).toBeNull()
  })

  test("validates construction", () => {
    expect(() => pickLanguage(null, [] as const, "" as never)).toThrow(/supported/)
    expect(() => language({ supported, defaultLanguage: "de" as "en" })).toThrow(/defaultLanguage/)
  })
})
