import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { batch, bindList, computed, signal } from "../src/islands.ts"

// A container modelling the child-list operations bindList uses, counting each move.
class Row {
  parent: List | undefined
  constructor(
    readonly key: string,
    public text = "",
  ) {}
  remove(): void {
    this.parent?.take(this)
  }
}
class List {
  rows: Row[] = []
  moves = 0
  take(row: Row): void {
    const at = this.rows.indexOf(row)
    if (at >= 0) this.rows.splice(at, 1)
    row.parent = undefined
  }
  replaceChildren(...rows: Row[]): void {
    for (const row of this.rows) row.parent = undefined
    this.rows = []
    for (const row of rows) this.insertBefore(row, null)
    this.moves = 0
  }
  insertBefore(row: Row, before: Row | null): void {
    row.parent?.take(row)
    const at = before === null ? this.rows.length : this.rows.indexOf(before)
    this.rows.splice(at, 0, row)
    row.parent = this
    this.moves++
  }
  keys(): string[] {
    return this.rows.map((row) => row.key)
  }
}

type Item = { id: string; label: string }
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id, label: id }))

function setup(initial: Item[]) {
  const list = signal(initial)
  const container = new List()
  let creates = 0
  const stop = bindList<Item, Row>(list, container, {
    key: (item) => item.id,
    create: (item) => {
      creates++
      return new Row(item.id)
    },
    update: (el, item) => {
      el.text = item.label
    },
  })
  return { list, container, stop, creates: () => creates }
}

describe("bindList", () => {
  afterEach(() => {
    spyOn(console, "warn").mockRestore()
  })

  test("the first render replaces the container's children with one node per item", () => {
    const { container, creates } = setup(items("a", "b", "c"))
    expect(container.keys()).toEqual(["a", "b", "c"])
    expect(creates()).toBe(3)
    expect(container.rows.map((r) => r.text)).toEqual(["a", "b", "c"])
  })

  test("a surviving item keeps its node across reorder, insert and removal", () => {
    const { list, container, creates } = setup(items("a", "b", "c"))
    const [a, b, c] = container.rows
    list.set(items("c", "x", "a"))
    expect(container.keys()).toEqual(["c", "x", "a"])
    expect(container.rows[0]).toBe(c)
    expect(container.rows[2]).toBe(a)
    expect(b?.parent).toBeUndefined()
    expect(creates()).toBe(4)
  })

  test("swapping two rows of 1,000 moves two nodes, not 1,000", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `k${i}`)
    const { list, container } = setup(items(...ids))
    const swapped = ids.slice()
    swapped[1] = "k998"
    swapped[998] = "k1"
    list.set(items(...swapped))
    expect(container.keys()).toEqual(swapped)
    expect(container.moves).toBe(2)
  })

  test("an update in place moves nothing; a reverse moves all but one", () => {
    const { list, container } = setup(items("a", "b", "c", "d"))
    list.set([{ id: "a", label: "A" }, ...items("b", "c", "d")])
    expect(container.moves).toBe(0)
    expect(container.rows[0]?.text).toBe("A")
    list.set(items("d", "c", "b", "a"))
    expect(container.keys()).toEqual(["d", "c", "b", "a"])
    expect(container.moves).toBe(3)
  })

  test("a duplicate key renders once and warns with the key", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const { list, container } = setup(items("a", "a", "b"))
    list.set(items("b", "b", "a"))
    expect(container.keys()).toEqual(["b", "a"])
    expect(warn.mock.calls.map((call) => call[1])).toEqual(["a", "b"])
  })

  test("emptying the list and refilling it renders afresh", () => {
    const { list, container, creates } = setup(items("a", "b"))
    list.set([])
    expect(container.keys()).toEqual([])
    list.set(items("b", "c"))
    expect(container.keys()).toEqual(["b", "c"])
    expect(creates()).toBe(4)
  })

  test("a signal read in update does not re-render the list", () => {
    const list = signal(items("a"))
    const mark = signal("*")
    let updates = 0
    bindList<Item, Row>(list, new List(), {
      key: (item) => item.id,
      create: (item) => new Row(item.id),
      update: (el, item) => {
        updates++
        el.text = item.label + mark()
      },
    })
    mark.set("!")
    expect(updates).toBe(1)
  })

  test("batched writes render once; a disposed list stops rendering", () => {
    const { list, container, stop } = setup(items("a"))
    batch(() => {
      list.set(items("a", "b"))
      list.set(items("b", "a", "c"))
    })
    expect(container.keys()).toEqual(["b", "a", "c"])
    stop()
    list.set(items("z"))
    expect(container.keys()).toEqual(["b", "a", "c"])
  })

  test("a computed source re-renders when its inputs change", () => {
    const all = signal(items("anvil", "axle", "bolt"))
    const prefix = signal("a")
    const shown = computed(() => all().filter((item) => item.id.startsWith(prefix())))
    const container = new List()
    bindList<Item, Row>(shown, container, {
      key: (item) => item.id,
      create: (item) => new Row(item.id),
    })
    expect(container.keys()).toEqual(["anvil", "axle"])
    prefix.set("b")
    expect(container.keys()).toEqual(["bolt"])
  })

  test("real DOM containers and rows typecheck, with the row type taken from create", () => {
    // Compiled by the repository typecheck; never run, since the test runtime has no document.
    const typed = (
      todos: () => ReadonlyArray<{ id: string; text: string }>,
      ul: HTMLUListElement,
    ) => [
      bindList(todos, ul, {
        key: (t) => t.id,
        create: () => document.createElement("li"),
        update: (li, t) => {
          li.textContent = t.text
        },
      }),
      bindList(todos, document.createElement("table"), {
        key: (t) => t.id,
        create: (t) => {
          const tr = document.createElement("tr")
          tr.id = t.id
          return tr
        },
        update: (tr) => {
          tr.deleteCell(0)
        },
      }),
    ]
    expect(typeof typed).toBe("function")
  })
})
