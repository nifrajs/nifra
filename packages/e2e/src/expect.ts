import { E2EError, type ElementState } from "./engine.ts"
import { Locator, type LocatorContext } from "./locator.ts"

export interface MatcherOptions {
  /** Overrides the session's `assertionTimeout` for this assertion, in ms. */
  readonly timeout?: number
}

/** Anything with a current URL; `E2ESession` is one. */
export interface UrlSource {
  readonly context: LocatorContext
  url(): Promise<string>
  /** Path plus query of the current URL. */
  path(): Promise<string>
}

export interface LocatorMatchers {
  toBeVisible(options?: MatcherOptions): Promise<void>
  toBeHidden(options?: MatcherOptions): Promise<void>
  toHaveText(expected: string | RegExp, options?: MatcherOptions): Promise<void>
  toContainText(expected: string | RegExp, options?: MatcherOptions): Promise<void>
  toHaveCount(expected: number, options?: MatcherOptions): Promise<void>
  toHaveValue(expected: string | RegExp, options?: MatcherOptions): Promise<void>
  readonly not: LocatorMatchers
}

export interface UrlMatchers {
  toHaveURL(expected: string | RegExp, options?: MatcherOptions): Promise<void>
  readonly not: UrlMatchers
}

interface Outcome {
  readonly pass: boolean
  readonly received: string
  /** The page cannot answer yet (for example, several elements for a one-element matcher): neither the assertion nor its negation holds. */
  readonly indeterminate?: true
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim()

function matches(received: string, expected: string | RegExp, substring: boolean): boolean {
  if (typeof expected !== "string") return expected.test(received)
  return substring
    ? normalize(received).includes(normalize(expected))
    : normalize(received) === normalize(expected)
}

function single(states: readonly ElementState[], check: (state: ElementState) => Outcome): Outcome {
  const [only] = states
  if (only === undefined) return { pass: false, received: "no element" }
  if (states.length > 1) {
    return { pass: false, received: `${states.length} elements, expected one`, indeterminate: true }
  }
  return check(only)
}

async function retry(
  context: LocatorContext,
  timeout: number,
  negate: boolean,
  describe: string,
  evaluate: () => Promise<Outcome>,
): Promise<void> {
  const deadline = context.clock.now() + timeout
  for (;;) {
    const outcome = await evaluate()
    if (outcome.indeterminate !== true && outcome.pass !== negate) {
      await context.onCheck?.(true)
      return
    }
    const remaining = deadline - context.clock.now()
    if (remaining <= 0) {
      await context.onCheck?.(false)
      throw new E2EError(
        "EXPECT_FAILED",
        `expected ${negate ? "not " : ""}${describe}, received ${outcome.received} (after ${timeout} ms)`,
      )
    }
    await context.clock.sleep(Math.min(context.pollInterval, remaining))
  }
}

function locatorMatchers(locator: Locator, negate: boolean): LocatorMatchers {
  const { context } = locator
  const run = (
    describe: string,
    options: MatcherOptions | undefined,
    evaluate: (states: readonly ElementState[]) => Outcome,
  ): Promise<void> =>
    retry(
      context,
      options?.timeout ?? context.assertionTimeout,
      negate,
      `${locator.describe()} ${describe}`,
      async () => evaluate(await locator.states()),
    )
  return {
    toBeVisible: (options) =>
      run("to be visible", options, (states) =>
        single(states, (s) => ({ pass: s.visible, received: s.visible ? "visible" : "hidden" })),
      ),
    toBeHidden: (options) =>
      run("to be hidden", options, (states) => {
        const shown = states.filter((s) => s.visible).length
        return { pass: shown === 0, received: `${shown} visible` }
      }),
    toHaveText: (expected, options) =>
      run(`to have text ${String(expected)}`, options, (states) =>
        single(states, (s) => ({
          pass: matches(s.text, expected, false),
          received: JSON.stringify(normalize(s.text)),
        })),
      ),
    toContainText: (expected, options) =>
      run(`to contain text ${String(expected)}`, options, (states) =>
        single(states, (s) => ({
          pass: matches(s.text, expected, true),
          received: JSON.stringify(normalize(s.text)),
        })),
      ),
    toHaveCount: (expected, options) =>
      run(`to have count ${expected}`, options, (states) => ({
        pass: states.length === expected,
        received: String(states.length),
      })),
    toHaveValue: (expected, options) =>
      run(`to have value ${String(expected)}`, options, (states) =>
        single(states, (s) => {
          const value = s.value ?? ""
          return {
            pass: typeof expected === "string" ? value === expected : expected.test(value),
            received: JSON.stringify(value),
          }
        }),
      ),
    get not() {
      return locatorMatchers(locator, !negate)
    },
  }
}

function urlMatchers(source: UrlSource, negate: boolean): UrlMatchers {
  return {
    toHaveURL: (expected, options) =>
      retry(
        source.context,
        options?.timeout ?? source.context.assertionTimeout,
        negate,
        `URL to be ${String(expected)}`,
        async () => {
          const received =
            typeof expected === "string" && expected.startsWith("/")
              ? await source.path()
              : await source.url()
          return {
            pass: typeof expected === "string" ? received === expected : expected.test(received),
            received,
          }
        },
      ),
    get not() {
      return urlMatchers(source, !negate)
    },
  }
}

export function expect(subject: Locator): LocatorMatchers
export function expect(subject: UrlSource): UrlMatchers
export function expect(subject: Locator | UrlSource): LocatorMatchers | UrlMatchers {
  return subject instanceof Locator ? locatorMatchers(subject, false) : urlMatchers(subject, false)
}
