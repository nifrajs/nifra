import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CacheEntry,
  createCache,
  defaultCacheMode,
  fileCacheStore,
  memoryCacheStore,
  parseEntry,
  performedOf,
} from "../src/cache.ts"
import { checkEvidence, diffEvidence } from "../src/evidence.ts"
import { fillUnique, keyParams, Secret, templatize, unique } from "../src/params.ts"
import { normalizeRoute } from "../src/route.ts"

const entry: CacheEntry = {
  version: 1,
  instruction: "sign in",
  startRoute: "/",
  actions: [
    { kind: "fill", target: { label: "Email" }, matches: 1, value: "{email}" },
    { kind: "press", target: { label: "Email" }, matches: 1, key: "Enter" },
    { kind: "tap", target: { role: "button", name: "Go", nth: 1 }, matches: 2 },
    { kind: "goto", path: "/home" },
  ],
  end: { route: "/home", appeared: ['- heading "Home"'], disappeared: [] },
}

describe("parseEntry", () => {
  test("reads back what was written", () => {
    expect(parseEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry)
  })

  test("refuses anything that is not a whole entry", () => {
    const bad: unknown[] = [
      null,
      "x",
      { ...entry, version: 2 },
      { ...entry, end: null },
      { ...entry, instruction: 1 },
      { ...entry, startRoute: 1 },
      { ...entry, end: { ...entry.end, route: 1 } },
      { ...entry, end: { ...entry.end, appeared: "x" } },
      { ...entry, end: { ...entry.end, disappeared: [1] } },
      { ...entry, actions: [] },
      { ...entry, actions: "x" },
      { ...entry, actions: [{ kind: "done" }] },
      { ...entry, actions: [{ kind: "tap", target: { role: "button" } }] },
      { ...entry, actions: [{ kind: "tap", target: { role: "button" }, matches: 0 }] },
      { ...entry, actions: [{ kind: "tap", target: { role: "button" }, matches: 1.5 }] },
      { ...entry, actions: [{ kind: "dance" }] },
    ]
    for (const raw of bad) expect(parseEntry(raw)).toBeUndefined()
  })

  test("performedOf drops the bookkeeping", () => {
    expect(entry.actions.map(performedOf)).toEqual([
      { kind: "fill", target: { label: "Email" }, value: "{email}" },
      { kind: "press", target: { label: "Email" }, key: "Enter" },
      { kind: "tap", target: { role: "button", name: "Go", nth: 1 } },
      { kind: "goto", path: "/home" },
    ])
  })
})

describe("stores", () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })
  const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-cache-"))
    dirs.push(dir)
    return dir
  }

  test("the file store writes, reads, replaces and deletes one JSON per key", async () => {
    const dir = join(await scratch(), "nested")
    const store = fileCacheStore(dir)
    expect(await store.read("k")).toBeUndefined()
    await store.write("k", entry)
    expect(await readdir(dir)).toEqual(["k.json"])
    expect(await store.read("k")).toEqual(entry)
    await store.write("k", { ...entry, instruction: "again" })
    expect((await store.read("k"))?.instruction).toBe("again")
    await store.delete("k")
    await store.delete("k")
    expect(await store.read("k")).toBeUndefined()
  })

  test("a corrupt or foreign file is a miss", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "bad.json"), "{not json")
    await writeFile(join(dir, "other.json"), '{"version":9}')
    const store = fileCacheStore(dir)
    expect(await store.read("bad")).toBeUndefined()
    expect(await store.read("other")).toBeUndefined()
  })

  test("the memory store is a map", async () => {
    const store = memoryCacheStore()
    await store.write("k", entry)
    expect(await store.read("k")).toBe(entry)
    await store.delete("k")
    expect(store.entries.size).toBe(0)
  })
})

describe("createCache", () => {
  test("keys follow the test, the instruction, the params, the context and the app", async () => {
    const make = (testId: string, appIdentity = "") =>
      createCache({ store: memoryCacheStore(), testId, appIdentity })
    const a = make("t")
    const same = make("t")
    const keyA = a.key("go", { n: 1 }, undefined)
    expect(same.key("go", { n: 1 }, undefined)).toBe(keyA)
    expect(keyA).toMatch(/^[0-9a-f]{32}$/)
    expect(a.key("go", { n: 1 }, undefined)).not.toBe(keyA)
    const fresh = make("t")
    for (const different of [
      fresh.key("stop", { n: 1 }, undefined),
      fresh.key("go", { n: 2 }, undefined),
      fresh.key("go", { n: 1 }, "Acme"),
      make("u").key("go", { n: 1 }, undefined),
      make("t", "v2").key("go", { n: 1 }, undefined),
    ]) {
      expect(different).not.toBe(keyA)
    }
  })

  test("a unique or a secret does not change the key, a plain value does", async () => {
    const cache = () => createCache({ store: memoryCacheStore(), testId: "t" })
    const first = cache().key("go", { a: unique("x"), b: new Secret("b", "1") }, undefined)
    const second = cache().key("go", { a: unique("y"), b: new Secret("b", "2") }, undefined)
    expect(second).toBe(first)
    expect(keyParams({ n: 1, s: "a", t: true })).toBe('[["n","1"],["s","a"],["t","true"]]')
  })

  test("a store that refuses is counted, not thrown", async () => {
    const broken = {
      read: async () => undefined,
      write: async () => {
        throw new Error("disk full")
      },
      delete: async () => {
        throw new Error("disk full")
      },
    }
    const cache = createCache({ store: broken, mode: "read-write", testId: "t" })
    cache.stage("k", entry)
    await cache.onCheck(true)
    await cache.discard("k")
    cache.replayed("k")
    await cache.onCheck(false)
    expect(cache.failures).toBe(3)
  })

  test("modes", async () => {
    for (const [mode, canWrite] of [
      ["read-write", true],
      ["read-only", false],
      ["strict", false],
      ["off", false],
    ] as const) {
      expect(createCache({ store: memoryCacheStore(), mode }).canWrite).toBe(canWrite)
    }
    const saved = process.env.CI
    try {
      process.env.CI = "true"
      expect(defaultCacheMode()).toBe("read-only")
      process.env.CI = ""
      expect(defaultCacheMode()).toBe("read-write")
      delete process.env.CI
      expect(defaultCacheMode()).toBe("read-write")
    } finally {
      if (saved !== undefined) process.env.CI = saved
    }
  })
})

describe("normalizeRoute", () => {
  const origin = "http://127.0.0.1:4000"
  test("drops the app origin and the hash, keeps another origin", () => {
    expect(normalizeRoute(`${origin}/a/b#x`, origin)).toBe("/a/b")
    expect(normalizeRoute("https://other.test/a", origin)).toBe("https://other.test/a")
  })

  test("ids, uuids, hex, timestamps and tokens become :id; words stay", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    expect(normalizeRoute(`${origin}/users/42/orders/${uuid}`, origin)).toBe(
      "/users/:id/orders/:id",
    )
    expect(normalizeRoute(`${origin}/s/0123456789abcdef0123`, origin)).toBe("/s/:id")
    expect(normalizeRoute(`${origin}/t/abcDEF123456abcDEF123456`, origin)).toBe("/t/:id")
    expect(normalizeRoute(`${origin}/settings/billing`, origin)).toBe("/settings/billing")
  })

  test("the query is sorted and its ids normalized", () => {
    expect(normalizeRoute(`${origin}/p?b=2&a=x`, origin)).toBe("/p?a=x&b=:id")
  })
})

describe("evidence", () => {
  const before = [
    '- heading "Sign in" [level=1]',
    '- textbox "Email": ada',
    '- button "Sign in"',
    "- paragraph: x",
  ].join("\n")
  const after = [
    '- heading "Home" [level=1]',
    '- checkbox "Remember" [checked]',
    "- status: Pro",
    '- textbox "Email"',
    '- button "Menu" [expanded] [disabled]',
    "- paragraph: new",
  ].join("\n")

  test("controls and headings that came or went, typed text and noise left out", () => {
    expect(diffEvidence(before, after)).toEqual({
      appeared: [
        '- heading "Home"',
        '- checkbox "Remember" [checked]',
        "- status: Pro",
        '- button "Menu" [expanded]',
      ],
      disappeared: ['- heading "Sign in"', '- button "Sign in"'],
    })
    expect(diffEvidence(before, before)).toEqual({ appeared: [], disappeared: [] })
  })

  test("a check names what is missing or lingering", () => {
    const evidence = { appeared: ['- heading "Home"'], disappeared: ['- button "Sign in"'] }
    expect(checkEvidence(evidence, after)).toEqual({ ok: true })
    expect(checkEvidence(evidence, before)).toEqual({
      ok: false,
      detail: 'expected - heading "Home" to be on the page',
    })
    expect(checkEvidence(evidence, `${after}\n- button "Sign in"`)).toEqual({
      ok: false,
      detail: 'expected - button "Sign in" to be gone',
    })
  })

  test("a line the pattern cannot split is kept whole", () => {
    expect(diffEvidence("", '- button name-without-quotes "x" y').appeared).toEqual([
      '- button name-without-quotes "x" y',
    ])
  })

  test("a state is part of a line's identity", () => {
    const evidence = { appeared: ['- checkbox "A" [checked]'], disappeared: [] }
    expect(checkEvidence(evidence, '- checkbox "A"').ok).toBe(false)
    expect(checkEvidence(evidence, '- checkbox "A" [checked]').ok).toBe(true)
  })
})

describe("unique params", () => {
  test("templatize and fillUnique round-trip, other placeholders stay", () => {
    const params = { email: unique("a-1@x.test"), plan: "pro" }
    const template = templatize("mail a-1@x.test plan pro", params)
    expect(template).toBe("mail {email} plan pro")
    expect(
      fillUnique("{email} {plan} {missing}", { email: unique("b-2@x.test"), plan: "pro" }),
    ).toBe("b-2@x.test {plan} {missing}")
    expect(templatize("x", { empty: unique("") })).toBe("x")
  })
})
