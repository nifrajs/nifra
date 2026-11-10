export type E2EErrorCode =
  | "LOCATOR_NOT_FOUND"
  | "LOCATOR_AMBIGUOUS"
  | "EXPECT_FAILED"
  | "HYDRATION_TIMEOUT"
  | "ENGINE_MISSING"
  | "NAVIGATION_FAILED"
  | "BAD_PATH"
  | "MODEL_MISSING"
  | "MODEL_INVALID"
  | "STEP_FAILED"
  | "STEP_BUDGET_EXCEEDED"
  | "STEP_TIMEOUT"
  | "ASSERTION_FAILED"
  | "ASSERTION_INCONCLUSIVE"
  | "WAIT_TIMEOUT"
  | "EXTRACT_INVALID"
  | "REPLAY_MISSING"
  | "REPLAY_STALE"

export class E2EError extends Error {
  readonly code: E2EErrorCode

  constructor(code: E2EErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "E2EError"
    this.code = code
  }
}

/** One link of a locator chain; the first finds from the page, each later one searches inside the matches so far. */
export type Step =
  | {
      readonly kind: "role"
      readonly role: string
      readonly name?: string
      readonly exact?: boolean
    }
  | { readonly kind: "label"; readonly text: string; readonly exact?: boolean }
  | { readonly kind: "text"; readonly text: string; readonly exact?: boolean }
  | { readonly kind: "testId"; readonly id: string }
  | { readonly kind: "hasText"; readonly text: string }
  | { readonly kind: "nth"; readonly index: number }

export type Selector = readonly Step[]

export interface ElementState {
  readonly visible: boolean
  readonly text: string
  readonly value?: string
}

export type ElementAction =
  | { readonly kind: "tap" }
  | { readonly kind: "fill"; readonly value: string }
  | { readonly kind: "press"; readonly key: string }

/**
 * What a browser or device must offer. `act` waits up to `timeout` ms for exactly one actionable
 * match, then performs the action; it throws `LOCATOR_NOT_FOUND` or `LOCATOR_AMBIGUOUS` otherwise.
 * `resolve` never waits and never throws on zero matches.
 */
export interface Engine {
  goto(url: string): Promise<void>
  url(): Promise<string>
  resolve(selector: Selector): Promise<readonly ElementState[]>
  /** The page as an accessibility-tree outline, one node per line; what an agent step reads. */
  snapshot(): Promise<string>
  act(selector: Selector, action: ElementAction, timeout: number): Promise<void>
  close(): Promise<void>
}

export interface EngineInit {
  readonly baseUrl: string
  readonly cookies: readonly { readonly name: string; readonly value: string }[]
  readonly hydration: HydrationMode
}

export type EngineFactory = (init: EngineInit) => Promise<Engine>

/** `auto` waits for nifra's `data-nifra-hydrated` marker only on pages that load a module script. */
export type HydrationMode = "auto" | "off"

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
