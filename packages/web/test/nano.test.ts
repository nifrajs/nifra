import { describe, expect, test } from "bun:test"
import { bind, bindList, bindResource, computed, resource, signal } from "../src/nano.ts"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Bun's test env has no `document`, and nano's list code only ever calls `appendChild`/`remove` and
// reads nothing else off a node, so a minimal parent/children stub with real move semantics stands in
// for the DOM (appendChild of an attached node detaches it first, exactly like the browser). Test-only.
interface FakeEl {
  tag: string
  children: FakeEl[]
  parent: FakeEl | null
  appendChild(child: FakeEl): FakeEl
  remove(): void
}
function el(tag = "div"): FakeEl {
  const node: FakeEl = {
    tag,
    children: [],
    parent: null,
    appendChild(child) {
      if (child.parent) {
        const i = child.parent.children.indexOf(child)
        if (i >= 0) child.parent.children.splice(i, 1)
      }
      child.parent = node
      node.children.push(child)
      return child
    },
    remove() {
      if (node.parent) {
        const i = node.parent.children.indexOf(node)
        if (i >= 0) node.parent.children.splice(i, 1)
        node.parent = null
      }
    },
  }
  return node
}
const asEl = (n: FakeEl): HTMLElement => n as unknown as HTMLElement

describe("signal", () => {
  test("get returns the current value; set updates it", () => {
    const s = signal(1)
    expect(s.get()).toBe(1)
    s.set(2)
    expect(s.get()).toBe(2)
  })

  test("subscribe fires on change and the returned unsubscribe stops it", () => {
    const s = signal(0)
    const seen: number[] = []
    const off = s.subscribe((v) => seen.push(v))
    s.set(1)
    s.set(2)
    off()
    s.set(3)
    expect(seen).toEqual([1, 2])
    expect(s.get()).toBe(3)
  })

  test("an unchanged write (Object.is) notifies nobody", () => {
    const s = signal(5)
    let calls = 0
    s.subscribe(() => calls++)
    s.set(5)
    expect(calls).toBe(0)
  })

  test("a throwing subscriber is isolated from the others", () => {
    const s = signal(0)
    let reached = false
    s.subscribe(() => {
      throw new Error("boom")
    })
    s.subscribe(() => {
      reached = true
    })
    s.set(1)
    expect(reached).toBe(true)
  })
})

describe("computed", () => {
  test("derives from declared deps and recomputes when one changes", () => {
    const a = signal(2)
    const b = signal(3)
    const sum = computed(() => a.get() + b.get(), [a, b])
    expect(sum.get()).toBe(5)
    a.set(10)
    expect(sum.get()).toBe(13)
  })

  test("notifies own subscribers only when the derived value changes", () => {
    const n = signal(4)
    const isEven = computed(() => n.get() % 2 === 0, [n])
    const seen: boolean[] = []
    isEven.subscribe((v) => seen.push(v))
    n.set(6) // still even -> derived value unchanged -> no notify
    n.set(7) // now odd -> notify once
    expect(seen).toEqual([false])
    expect(isEven.get()).toBe(false)
  })
})

describe("resource", () => {
  test("starts pending, then ready with the resolved value", async () => {
    const res = resource(async () => 42)
    expect(res.get().status).toBe("pending")
    await tick()
    expect(res.get()).toEqual({ status: "ready", value: 42, error: undefined })
  })

  test("a rejected fetch lands in the error state", async () => {
    const boom = new Error("boom")
    const res = resource(async () => {
      throw boom
    })
    await tick()
    expect(res.get().status).toBe("error")
    expect(res.get().error).toBe(boom)
  })

  test("refetches when a declared dep changes", async () => {
    const id = signal(1)
    let calls = 0
    const res = resource(async () => {
      calls++
      return id.get() * 10
    }, [id])
    await tick()
    expect(res.get().value).toBe(10)
    id.set(2)
    await tick()
    expect(res.get().value).toBe(20)
    expect(calls).toBe(2)
  })

  test("drops a stale in-flight result when superseded (last write wins)", async () => {
    const id = signal(1)
    const first = deferred<number>()
    const second = deferred<number>()
    const res = resource(() => (id.get() === 1 ? first.promise : second.promise), [id])
    id.set(2) // supersede before the first resolves
    second.resolve(200)
    await tick()
    first.resolve(100) // stale - must be ignored
    await tick()
    expect(res.get().value).toBe(200)
  })

  test("aborts the superseded fetch via its AbortSignal", async () => {
    const id = signal(1)
    let firstAborted = false
    const res = resource(
      (sig) => {
        const mine = id.get()
        if (mine === 1) sig.addEventListener("abort", () => (firstAborted = true))
        return Promise.resolve(mine)
      },
      [id],
    )
    id.set(2)
    await tick()
    expect(firstAborted).toBe(true)
    expect(res.get().value).toBe(2)
  })

  test("refetch() re-runs the fetcher on demand", async () => {
    let calls = 0
    const res = resource(async () => ++calls)
    await tick()
    expect(res.get().value).toBe(1)
    res.refetch()
    await tick()
    expect(res.get().value).toBe(2)
  })
})

describe("bindResource", () => {
  test("dispatches pending -> ready onto the element and returns a disposer", async () => {
    const d = deferred<string>()
    const res = resource(() => d.promise)
    const node = el()
    const log: string[] = []
    const off = bindResource(asEl(node), res, {
      pending: () => log.push("pending"),
      ready: (_, v) => log.push(`ready:${v}`),
      error: () => log.push("error"),
    })
    expect(log).toEqual(["pending"]) // applied immediately
    d.resolve("hi")
    await tick()
    expect(log).toEqual(["pending", "ready:hi"])
    off()
  })

  test("a missing pending handler is simply skipped (ready still fires)", async () => {
    const res = resource(async () => 7)
    const node = el()
    let readied = 0
    bindResource(asEl(node), res, { ready: () => readied++ })
    await tick()
    expect(readied).toBe(1)
  })
})

describe("bind", () => {
  test("applies immediately and on every change; cleanup unsubscribes", () => {
    const s = signal("a")
    const node = el()
    const applied: string[] = []
    const off = bind(asEl(node), s, (_, v) => applied.push(v))
    s.set("b")
    off()
    s.set("c")
    expect(applied).toEqual(["a", "b"])
  })
})

describe("bindList", () => {
  type Row = { id: number; text: string }
  const keysOf = (c: FakeEl) => c.children.map((child) => (child as unknown as { key: number }).key)

  function listHarness() {
    const created: number[] = []
    const container = el("ul")
    const items = signal<Row[]>([])
    const off = bindList(items, asEl(container), {
      key: (r) => r.id,
      create: (r) => {
        created.push(r.id)
        const li = el("li") as FakeEl & { key: number; label: string }
        li.key = r.id
        return asEl(li)
      },
      update: (node, r) => {
        ;(node as unknown as { label: string }).label = r.text
      },
    })
    return { created, container, items, off }
  }

  test("creates a node per item in order", () => {
    const h = listHarness()
    h.items.set([
      { id: 1, text: "a" },
      { id: 2, text: "b" },
    ])
    expect(keysOf(h.container)).toEqual([1, 2])
    expect(h.created).toEqual([1, 2])
  })

  test("adding an item creates only the new node; survivors are reused", () => {
    const h = listHarness()
    h.items.set([{ id: 1, text: "a" }])
    h.items.set([
      { id: 1, text: "a" },
      { id: 2, text: "b" },
    ])
    expect(h.created).toEqual([1, 2]) // 1 was not re-created
    expect(keysOf(h.container)).toEqual([1, 2])
  })

  test("removing an item detaches only that node", () => {
    const h = listHarness()
    h.items.set([
      { id: 1, text: "a" },
      { id: 2, text: "b" },
      { id: 3, text: "c" },
    ])
    h.items.set([
      { id: 1, text: "a" },
      { id: 3, text: "c" },
    ])
    expect(keysOf(h.container)).toEqual([1, 3])
    expect(h.created).toEqual([1, 2, 3]) // nothing re-created on removal
  })

  test("reordering reuses the same nodes and matches the new order", () => {
    const h = listHarness()
    const a = { id: 1, text: "a" }
    const b = { id: 2, text: "b" }
    const c = { id: 3, text: "c" }
    h.items.set([a, b, c])
    const before = [...h.container.children]
    h.items.set([c, a, b])
    expect(keysOf(h.container)).toEqual([3, 1, 2])
    expect(h.created).toEqual([1, 2, 3]) // reorder created nothing
    // same element instances, just moved
    expect(new Set(h.container.children)).toEqual(new Set(before))
  })

  test("update runs on survivors", () => {
    const h = listHarness()
    h.items.set([{ id: 1, text: "a" }])
    h.items.set([{ id: 1, text: "renamed" }])
    expect((h.container.children[0] as unknown as { label: string }).label).toBe("renamed")
  })
})
