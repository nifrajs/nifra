import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type Blocker,
  type BlockerFunction,
  IDLE_BLOCKER,
  type RenderProps,
  rawHref,
  setBlockerController,
  setBrowserNavigate,
} from "@nifrajs/web"
import { get } from "svelte/store"
import { useBlocker, useNavigate } from "../src/router.ts"

/**
 * The interception + restore-then-prompt state machine is tested exhaustively in `@nifrajs/web`'s suite.
 * What is specific here is the Svelte wiring: `useNavigate` over the navigate bridge, and `useBlocker`
 * as a `readable` store that registers on the first subscription and unregisters on the last.
 */

const loc = () => ({ pathname: "/", search: "", hash: "" })

afterEach(() => {
  setBrowserNavigate(undefined)
  setBlockerController(undefined)
})

function fakeController(): {
  shouldBlock?: BlockerFunction
  onChange?: (b: Blocker) => void
  unregistered: boolean
} {
  const cap = { unregistered: false } as {
    shouldBlock?: BlockerFunction
    onChange?: (b: Blocker) => void
    unregistered: boolean
  }
  setBlockerController({
    register(shouldBlock, onChange) {
      cap.shouldBlock = shouldBlock
      cap.onChange = onChange
      return () => {
        cap.unregistered = true
      }
    },
  })
  return cap
}

test("useNavigate forwards through the bridge and no-ops before it", () => {
  const nav = useNavigate()
  expect(() => nav(rawHref("/x"))).not.toThrow() // no bridge yet
  const calls: Array<[string | number, unknown]> = []
  setBrowserNavigate((to, o) => calls.push([to, o]))
  nav(rawHref("/next"), { replace: true })
  expect(calls).toEqual([["/next", { replace: true }]])
})

test("useBlocker registers on first subscribe, reflects state, unregisters on last unsubscribe", () => {
  const cap = fakeController()
  const blocker = useBlocker(() => true)
  const seen: Blocker["state"][] = []
  const unsubscribe = blocker.subscribe((b) => seen.push(b.state))

  // The start notifier ran on subscribe -> registered; initial value is idle.
  expect(get(blocker)).toBe(IDLE_BLOCKER)
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)

  cap.onChange?.({ state: "blocked", proceed: () => {}, reset: () => {} })
  expect(get(blocker).state).toBe("blocked")
  expect(seen).toEqual(["unblocked", "blocked"])

  unsubscribe()
  expect(cap.unregistered).toBe(true)
})

test("useBlocker boolean form reads as itself", () => {
  const cap = fakeController()
  const unsubscribe = useBlocker(true).subscribe(() => {})
  expect(cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })).toBe(true)
  unsubscribe()
})

test("a kept page's blocker blocks nothing, and its visibility reads false, while it is hidden", async () => {
  const { compile } = await import("svelte/compiler")
  const { render } = await import("svelte/server")
  const source = `<script>
  import { useBlocker, usePageVisibility } from ${JSON.stringify(join(import.meta.dir, "../src/router.ts"))}
  useBlocker(true).subscribe(() => {})
  const visible = usePageVisibility()
</script>
<p>{visible() ? "shown" : "hidden"}</p>`
  const dir = await mkdtemp(join(import.meta.dir, ".tmp-nifra-blocker-probe-"))
  try {
    const file = join(dir, "probe.js")
    await writeFile(file, compile(source, { generate: "server", filename: "Probe.svelte" }).js.code)
    const Probe = (await import(file)).default
    let hidden = true
    const visibility = { hidden: () => hidden, hide: new Set(), show: new Set() }
    const cap = fakeController()
    const context = new Map([["@nifrajs/web-svelte:visibility", visibility]])
    expect(render(Probe, { context }).body).toContain("<p>hidden</p>")
    const check = () => cap.shouldBlock?.({ currentLocation: loc(), nextLocation: loc() })
    expect(check()).toBe(false)
    hidden = false
    expect(check()).toBe(true)
    expect(render(Probe).body).toContain("<p>shown</p>")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("useSearch and useMatches read the chain's context, and report nothing outside one", async () => {
  // Compiled here rather than through the Bun plugin, which registers process-wide: this runs in the
  // test process, so the accessors count toward coverage.
  const { compile } = await import("svelte/compiler")
  const { render } = await import("svelte/server")
  const source = `<script>
  import { useMatches, useSearch } from ${JSON.stringify(join(import.meta.dir, "../src/router.ts"))}
  const search = useSearch()
  const matches = useMatches()
</script>
<p>{JSON.stringify(search())}|{JSON.stringify(matches().map((m) => [m.id, m.pathname]))}</p>`
  // `.tmp-nifra-*` directories are outside the coverage gate.
  const dir = await mkdtemp(join(import.meta.dir, ".tmp-nifra-router-probe-"))
  try {
    const file = join(dir, "probe.js")
    await writeFile(file, compile(source, { generate: "server", filename: "Probe.svelte" }).js.code)
    const Probe = (await import(file)).default
    const props: RenderProps = {
      data: null,
      path: "/orgs/acme",
      params: { org: "acme" },
      matchChain: { ids: ["_layout", "orgs/[org]"], handles: [undefined, undefined] },
    }
    const context = new Map<string, unknown>([
      ["@nifrajs/web-svelte:search", () => ({ page: 2 })],
      ["@nifrajs/web-svelte:props", () => props],
    ])
    const inside = render(Probe, { context }).body
    expect(inside).toContain('{"page":2}|[["_layout","/"],["orgs/[org]","/orgs/acme"]]')
    expect(render(Probe).body).toContain("{}|[]")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("onPageHide and onPageShow register with the kept page's slot, and do nothing outside one", async () => {
  // Compiled in the test process for the same reason as the probe above.
  const { compile } = await import("svelte/compiler")
  const { render } = await import("svelte/server")
  const source = `<script>
  import { onPageHide, onPageShow } from ${JSON.stringify(join(import.meta.dir, "../src/router.ts"))}
  let { report } = $props()
  report(onPageHide(() => {}), onPageShow(() => {}))
</script>
<p>page</p>`
  const dir = await mkdtemp(join(import.meta.dir, ".tmp-nifra-visibility-probe-"))
  try {
    const file = join(dir, "probe.js")
    await writeFile(file, compile(source, { generate: "server", filename: "Probe.svelte" }).js.code)
    const Probe = (await import(file)).default
    const visibility = { hide: new Set<() => void>(), show: new Set<() => void>() }
    const removals: (() => void)[] = []
    const report = (...remove: (() => void)[]) => removals.push(...remove)
    // The render runs when its body is read.
    const kept = render(Probe, {
      props: { report },
      context: new Map([["@nifrajs/web-svelte:visibility", visibility]]),
    }).body
    expect(kept).toContain("<p>page</p>")
    expect([visibility.hide.size, visibility.show.size]).toEqual([1, 1])
    for (const remove of removals) remove()
    expect([visibility.hide.size, visibility.show.size]).toEqual([0, 0])

    removals.length = 0
    expect(render(Probe, { props: { report } }).body).toContain("<p>page</p>")
    expect(removals).toHaveLength(2)
    for (const remove of removals) expect(remove).not.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
