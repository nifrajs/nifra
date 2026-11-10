import {
  E2EError,
  type ElementAction,
  type ElementState,
  type Engine,
  type EngineFactory,
  type Selector,
  type Step,
} from "./engine.ts"

/** A node of the in-memory page tree the fake engine matches locators against. */
export interface FakeNode {
  role?: string
  /** Accessible name, matched by `getByRole(role, name)`. */
  name?: string
  /** Own text, matched by `getByText`. */
  text?: string
  testId?: string
  /** Label text, matched by `getByLabel`. */
  label?: string
  value?: string
  hidden?: boolean
  children?: FakeNode[]
}

export interface FakeLogEntry {
  readonly kind: "goto" | ElementAction["kind"]
  readonly detail: string
}

export interface FakeEngineOptions {
  /** Pages by `pathname + search`, falling back to bare `pathname`. */
  readonly pages: Readonly<Record<string, readonly FakeNode[]>>
  /** Runs after a tap or press on the matched node; return a path to navigate to it. */
  readonly onAct?: (node: FakeNode, action: ElementAction) => string | undefined
}

interface Found {
  readonly node: FakeNode
  readonly visible: boolean
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim()

function textMatches(value: string, wanted: string, exact: boolean | undefined): boolean {
  return exact === true
    ? normalize(value) === normalize(wanted)
    : normalize(value).toLowerCase().includes(normalize(wanted).toLowerCase())
}

function textOf(node: FakeNode): string {
  return [node.text, ...(node.children ?? []).map(textOf)]
    .filter((part) => part !== undefined && part !== "")
    .join(" ")
}

function descend(nodes: readonly FakeNode[], hidden: boolean): Found[] {
  return nodes.flatMap((node) => {
    const isHidden = hidden || node.hidden === true
    return [{ node, visible: !isHidden }, ...descend(node.children ?? [], isHidden)]
  })
}

function accepts(step: Step, found: Found): boolean {
  const { node } = found
  switch (step.kind) {
    case "role":
      return (
        node.role === step.role &&
        (step.name === undefined || textMatches(node.name ?? "", step.name, step.exact))
      )
    case "label":
      return node.label !== undefined && textMatches(node.label, step.text, step.exact)
    case "text":
      return node.text !== undefined && textMatches(node.text, step.text, step.exact)
    case "testId":
      return node.testId === step.id
    case "hasText":
      return textMatches(textOf(node), step.text, false)
    case "nth":
      return true
  }
}

function run(roots: readonly FakeNode[], selector: Selector): Found[] {
  let scope: Found[] = [{ node: { children: [...roots] }, visible: true }]
  for (const step of selector) {
    if (step.kind === "hasText") {
      scope = scope.filter((found) => accepts(step, found))
      continue
    }
    if (step.kind === "nth") {
      scope = scope.slice(step.index, step.index + 1)
      continue
    }
    const seen = new Set<FakeNode>()
    scope = scope
      .flatMap((found) => descend(found.node.children ?? [], !found.visible))
      .filter((found) => accepts(step, found) && !seen.has(found.node) && seen.add(found.node))
  }
  return scope
}

function outline(nodes: readonly FakeNode[], depth: number): string[] {
  return nodes.flatMap((node) => {
    if (node.hidden === true) return []
    const indent = "  ".repeat(depth)
    const head = node.role ?? (node.text === undefined ? undefined : "text")
    const name = node.role !== undefined && node.name !== undefined ? ` "${node.name}"` : ""
    const own = node.text === undefined ? "" : `: ${node.text}`
    const children = outline(node.children ?? [], head === undefined ? depth : depth + 1)
    return head === undefined ? children : [`${indent}- ${head}${name}${own}`, ...children]
  })
}

function stateOf(found: Found): ElementState {
  const text = textOf(found.node)
  return found.node.value === undefined
    ? { visible: found.visible, text }
    : { visible: found.visible, text, value: found.node.value }
}

/**
 * An in-memory engine for tests of code built on `@nifrajs/e2e`: no browser, same locator
 * semantics (case-insensitive substring unless `exact`). It does not wait; an `act` on a missing
 * element throws at once.
 */
export function fakeEngine(options: FakeEngineOptions): {
  factory: EngineFactory
  log: FakeLogEntry[]
} {
  const log: FakeLogEntry[] = []
  const factory: EngineFactory = async () => {
    let current = ""
    let tree: FakeNode[] = []
    const engine: Engine = {
      async goto(url) {
        const target = new URL(url)
        const key = `${target.pathname}${target.search}`
        const page = options.pages[key] ?? options.pages[target.pathname]
        if (page === undefined) throw new E2EError("NAVIGATION_FAILED", `no fake page for ${key}`)
        log.push({ kind: "goto", detail: key })
        current = url
        tree = structuredClone([...page])
      },
      async url() {
        return current
      },
      async resolve(selector) {
        return run(tree, selector).map(stateOf)
      },
      async snapshot() {
        return outline(tree, 0).join("\n")
      },
      async act(selector, action) {
        const found = run(tree, selector).filter((candidate) => candidate.visible)
        const [match] = found
        if (match === undefined)
          throw new E2EError(
            "LOCATOR_NOT_FOUND",
            `no visible element for ${JSON.stringify(selector)}`,
          )
        if (found.length > 1)
          throw new E2EError(
            "LOCATOR_AMBIGUOUS",
            `${found.length} elements for ${JSON.stringify(selector)}`,
          )
        const { node } = match
        log.push({
          kind: action.kind,
          detail: action.kind === "fill" ? action.value : action.kind === "press" ? action.key : "",
        })
        if (action.kind === "fill") {
          node.value = action.value
          return
        }
        const next = options.onAct?.(node, action)
        if (next !== undefined) await engine.goto(new URL(next, current).href)
      },
      async close() {},
    }
    return engine
  }
  return { factory, log }
}
