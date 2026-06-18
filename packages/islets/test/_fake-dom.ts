/** Minimal structural DOM for driving the binder/island logic under bun:test (no real DOM).
 * Implements exactly the surfaces `BindableElement`/`BindableRoot` declare — if the walker grows
 * a DOM dependency these fakes don't model, the type system flags it here first. */

export class FakeElement {
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

const SELECTOR = /^\[([a-z-]+)\]$/

/** A root whose querySelectorAll supports exactly the `[data-attr]` selectors the walker uses. */
export class FakeRoot {
  constructor(readonly elements: FakeElement[]) {}
  querySelectorAll(selector: string): FakeElement[] {
    const m = SELECTOR.exec(selector)
    if (m === null) throw new Error(`fake DOM: unsupported selector ${selector}`)
    const attr = m[1] as string
    return this.elements.filter((el) => el.getAttribute(attr) !== null)
  }
}

/** An island host: an element that is also a root over its (flat) children. */
export class FakeHost extends FakeElement {
  constructor(
    attrs: Record<string, string>,
    readonly children: FakeElement[],
  ) {
    super(attrs)
  }
  querySelectorAll(selector: string): FakeElement[] {
    return new FakeRoot(this.children).querySelectorAll(selector)
  }
}
