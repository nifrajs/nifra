/** Minimal structural DOM for driving the binder/island logic under bun:test (no real DOM).
 * Implements exactly the surfaces `BindableElement`/`BindableRoot` declare - if the walker grows
 * a DOM dependency these fakes don't model, the type system flags it here first. */

export class FakeElement {
  parent: FakeElement | undefined
  private readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly classes = new Set<string>()
  textContent: string | null = null
  hidden = false
  value?: string

  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const want = force ?? !this.classes.has(name)
      if (want) this.classes.add(name)
      else this.classes.delete(name)
      return want
    },
  }

  constructor(attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
  }

  /** Whether this element or an ancestor carries `attr`. */
  within(attr: string): boolean {
    for (let el: FakeElement | undefined = this; el !== undefined; el = el.parent)
      if (el.getAttribute(attr) !== null) return true
    return false
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  dispatch(type: string, event: Partial<Event> = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(event as Event)
  }
}

// `[attr]`, optionally followed by `:not([x],[x] *)` - "not inside an element carrying x".
const SELECTOR = /^\[([a-z-]+)\](?::not\(\[([a-z-]+)\],\[\2\] \*\))?$/

/** A root whose querySelectorAll supports exactly the selectors the walker uses. */
export class FakeRoot {
  constructor(readonly elements: FakeElement[]) {}
  querySelectorAll(selector: string): FakeElement[] {
    const m = SELECTOR.exec(selector)
    if (m === null) throw new Error(`fake DOM: unsupported selector ${selector}`)
    const [, attr = "", outside] = m
    return this.elements.filter(
      (el) => el.getAttribute(attr) !== null && (outside === undefined || !el.within(outside)),
    )
  }
}

/** An element with children: an island host, or any container. Its root covers every descendant. */
export class FakeHost extends FakeElement {
  constructor(
    attrs: Record<string, string>,
    readonly children: FakeElement[],
  ) {
    super(attrs)
    for (const child of children) child.parent = this
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [
      child,
      ...(child instanceof FakeHost ? child.descendants() : []),
    ])
  }
  querySelectorAll(selector: string): FakeElement[] {
    return new FakeRoot(this.descendants()).querySelectorAll(selector)
  }
}
