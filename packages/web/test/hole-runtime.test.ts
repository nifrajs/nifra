import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { holeHost, initialHtml } from "../src/internal/hole-runtime.ts"
import { type ComponentClientAdapter, holeComponents } from "../src/server-components/client.ts"
import type { ComponentRecord } from "../src/server-components/types.ts"

// A hole host's DOM surface, faked: the runtime touches attributes, its children and the document's
// createElement. The adapters' DOM tests and the browser checks cover a real document.
class FakeHost {
  readonly attributes = new Map<string, string>()
  children: Array<{ readonly text: string }> = []
  readonly ownerDocument = {
    createElement: () => ({
      text: "",
      setAttribute() {},
      set textContent(value: string) {
        this.text = value
      },
    }),
  }
  get text(): string {
    return this.children.map((child) => child.text).join("")
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  replaceChildren(...nodes: Array<{ readonly text: string } | string>): void {
    this.children = nodes.map((node) => (typeof node === "string" ? { text: node } : node))
  }
}

const hostOf = (fake: FakeHost): Element =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: the fake implements every member the hole runtime calls on a host.
  fake as unknown as Element

const record = (start: number): Omit<ComponentRecord, "html"> => ({
  instance: "inst",
  reference: "ref_summary",
  key: "summary",
  parent: null,
  input: {},
  islands: [{ reference: "ref_counter", key: "k", props: { start }, renderId: "i_1" }],
})

/** A component client that logs each step, and holds each island root's disposal until released. */
function client() {
  const log: string[] = []
  const releases: Array<() => void> = []
  const adapter: ComponentClientAdapter = {
    name: "vue",
    prepare: (next) => {
      log.push(`prepare ${next.html}`)
      return next
    },
    hydrate: (_host, next) => {
      log.push(`hydrate ${next.html}`)
      return root(next.html)
    },
    create: (host, next) => {
      log.push(`create ${next.html}`)
      host.replaceChildren(next.html)
      return root(next.html)
    },
    update: () => {},
  }
  const root = (html: string) => ({
    update: () => {},
    dispose: () =>
      new Promise<void>((resolve) => {
        log.push(`dispose ${html}`)
        releases.push(() => {
          log.push(`disposed ${html}`)
          resolve()
        })
      }),
  })
  return { adapter, log, releases }
}

/** A stand-in for the shell's inline runtime, holding the fills the document carried. */
function runtime(fills: Record<string, unknown>) {
  Reflect.set(
    globalThis,
    "__nifraPpr",
    Object.assign(() => {}, {
      get: (name: string) => fills[name],
      subscribe: () => () => {},
      put: (_name: string, frame: { readonly html: string }, host: FakeHost) =>
        host.replaceChildren({ text: frame.html }),
    }),
  )
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

let quiet: { mockRestore(): void } | undefined
beforeEach(() => {
  quiet = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  quiet?.mockRestore()
  holeComponents(undefined)
  Reflect.deleteProperty(globalThis, "__nifraPpr")
})

test("a document's server component fill hydrates its islands over the server HTML", async () => {
  const { adapter, log } = client()
  holeComponents(adapter)
  runtime({ summary: { error: false, component: record(1), html: "<section>a</section>" } })
  const host = new FakeHost()
  holeHost("summary", hostOf(host), undefined)
  await flush()
  expect(log).toEqual(["prepare <section>a</section>", "hydrate <section>a</section>"])
  expect(host.attributes.get("aria-busy")).toBe("false")
})

test("a refill disposes the islands first, then puts the new HTML and mounts its islands", async () => {
  const { adapter, log, releases } = client()
  holeComponents(adapter)
  runtime({ summary: { error: false, component: record(1), html: "a" } })
  const host = new FakeHost()
  const driven = holeHost("summary", hostOf(host), undefined)
  await flush()
  driven.refill({ v: 1, html: "b", component: record(2) })
  await flush()
  // The old islands are still going: nothing new is put in the host until they are.
  expect(log.slice(2)).toEqual(["dispose a"])
  expect(host.attributes.get("aria-busy")).toBe("true")
  releases[0]?.()
  await flush()
  expect(log.slice(2)).toEqual(["dispose a", "disposed a", "prepare b", "create b"])
  expect(host.text).toBe("b")
  expect(host.attributes.has("data-nifra-filled")).toBe(true)
  expect(host.attributes.get("aria-busy")).toBe("false")
})

test("of two refills, the one given last wins, whichever settles first", async () => {
  const { adapter, log } = client()
  holeComponents(adapter)
  const host = new FakeHost()
  const driven = holeHost("summary", hostOf(host), undefined)
  let older: (frame: unknown) => void = () => {}
  driven.refill({ __nifra_deferred: true, promise: new Promise((resolve) => (older = resolve)) })
  driven.refill({ v: 1, html: "new", component: record(2) })
  await flush()
  older({ v: 1, html: "old", component: record(1) })
  await flush()
  expect(log).toEqual(["prepare new", "create new"])
  expect(host.text).toBe("new")
})

test("with no shell runtime, a fill still mounts, and an error builds the error slot without HTML", async () => {
  const { adapter, log, releases } = client()
  holeComponents(adapter)
  const host = new FakeHost()
  const driven = holeHost("summary", hostOf(host), undefined)
  driven.refill({ v: 1, html: "a", component: record(1) })
  await flush()
  expect(log).toEqual(["prepare a", "create a"])
  driven.refill({ v: 1, error: true, html: "<p>ignored</p>" })
  await flush()
  releases[0]?.()
  await flush()
  expect(host.text).toBe("This section is unavailable.")
  expect(host.attributes.has("data-nifra-hole-error")).toBe(true)
})

test("a fill whose record fails the protocol check mounts nothing and shows the error slot", async () => {
  const { adapter, log } = client()
  holeComponents(adapter)
  const host = new FakeHost()
  const driven = holeHost("summary", hostOf(host), undefined)
  driven.refill({ v: 1, html: "a", component: { ...record(1), instance: "not a token" } })
  await flush()
  expect(log).toEqual([])
  expect(host.text).toBe("This section is unavailable.")
})

test("without a component client the hole shows its error slot", async () => {
  const host = new FakeHost()
  const driven = holeHost("summary", hostOf(host), undefined)
  driven.refill({ v: 1, html: "a", component: record(1) })
  await flush()
  expect(host.text).toBe("This section is unavailable.")
})

test("a host renders a blocking render's settled HTML, and nothing for a deferred fill", () => {
  expect(initialHtml({ v: 1, html: "<section>a</section>" })).toBe("<section>a</section>")
  expect(initialHtml({ __nifra_deferred: true, html: "x" })).toBe("")
  expect(initialHtml(undefined)).toBe("")
})
