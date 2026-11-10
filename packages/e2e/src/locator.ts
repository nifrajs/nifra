import type { Clock, ElementState, Engine, Selector, Step } from "./engine.ts"

export interface LocatorContext {
  readonly engine: Engine
  readonly clock: Clock
  readonly actionTimeout: number
  readonly assertionTimeout: number
  readonly pollInterval: number
  /** Told when an assertion passes or fails, so the replay cache learns whether the steps before it held. */
  readonly onCheck?: ((passed: boolean) => Promise<void>) | undefined
}

export interface TextOptions {
  readonly exact?: boolean
}

export interface RoleOptions extends TextOptions {
  readonly name?: string
}

interface Finders {
  getByRole(role: string, nameOrOptions?: string | RoleOptions): Locator
  getByLabel(text: string, options?: TextOptions): Locator
  getByText(text: string, options?: TextOptions): Locator
  getByTestId(id: string): Locator
}

function roleStep(role: string, nameOrOptions: string | RoleOptions | undefined): Step {
  const options = typeof nameOrOptions === "string" ? { name: nameOrOptions } : nameOrOptions
  const step: { kind: "role"; role: string; name?: string; exact?: boolean } = {
    kind: "role",
    role,
  }
  if (options?.name !== undefined) step.name = options.name
  if (options?.exact !== undefined) step.exact = options.exact
  return step
}

function textStep(kind: "label" | "text", text: string, options: TextOptions | undefined): Step {
  const step: { kind: "label" | "text"; text: string; exact?: boolean } = { kind, text }
  if (options?.exact !== undefined) step.exact = options.exact
  return step
}

export class Locator implements Finders {
  readonly context: LocatorContext
  readonly selector: Selector

  constructor(context: LocatorContext, selector: Selector) {
    this.context = context
    this.selector = selector
  }

  #then(step: Step): Locator {
    return new Locator(this.context, [...this.selector, step])
  }

  getByRole(role: string, nameOrOptions?: string | RoleOptions): Locator {
    return this.#then(roleStep(role, nameOrOptions))
  }

  getByLabel(text: string, options?: TextOptions): Locator {
    return this.#then(textStep("label", text, options))
  }

  getByText(text: string, options?: TextOptions): Locator {
    return this.#then(textStep("text", text, options))
  }

  getByTestId(id: string): Locator {
    return this.#then({ kind: "testId", id })
  }

  nth(index: number): Locator {
    return this.#then({ kind: "nth", index })
  }

  filter(options: { readonly hasText: string }): Locator {
    return this.#then({ kind: "hasText", text: options.hasText })
  }

  states(): Promise<readonly ElementState[]> {
    return this.context.engine.resolve(this.selector)
  }

  async count(): Promise<number> {
    return (await this.states()).length
  }

  tap(): Promise<void> {
    return this.context.engine.act(this.selector, { kind: "tap" }, this.context.actionTimeout)
  }

  fill(value: string): Promise<void> {
    return this.context.engine.act(
      this.selector,
      { kind: "fill", value },
      this.context.actionTimeout,
    )
  }

  press(key: string): Promise<void> {
    return this.context.engine.act(
      this.selector,
      { kind: "press", key },
      this.context.actionTimeout,
    )
  }

  describe(): string {
    return this.selector.map(describeStep).join(" >> ")
  }
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "role":
      return step.name === undefined
        ? `role=${step.role}`
        : `role=${step.role}[name="${step.name}"]`
    case "label":
      return `label="${step.text}"`
    case "text":
      return `text="${step.text}"`
    case "testId":
      return `testId="${step.id}"`
    case "hasText":
      return `hasText="${step.text}"`
    case "nth":
      return `nth=${step.index}`
  }
}

/** The page root: every chain starts here. */
export class Screen implements Finders {
  readonly #root: Locator

  constructor(context: LocatorContext) {
    this.#root = new Locator(context, [])
  }

  getByRole(role: string, nameOrOptions?: string | RoleOptions): Locator {
    return this.#root.getByRole(role, nameOrOptions)
  }

  getByLabel(text: string, options?: TextOptions): Locator {
    return this.#root.getByLabel(text, options)
  }

  getByText(text: string, options?: TextOptions): Locator {
    return this.#root.getByText(text, options)
  }

  getByTestId(id: string): Locator {
    return this.#root.getByTestId(id)
  }
}
