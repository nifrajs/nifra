import { describe, expect, test } from "bun:test"
import { bind, bindList, computed, signal } from "../src/nano.ts"

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
