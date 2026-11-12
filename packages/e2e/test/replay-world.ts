import { server } from "@nifrajs/core"
import { type FakeNode, fakeEngine } from "../src/fake.ts"
import { type ActRequest, E2EError, type E2EModel, type ModelRequest } from "../src/index.ts"

export const app = server()
  .get("/", () => "start")
  .get("/alt", () => "alt")

/** One state of the fake product: how the sign-in page and its aftermath look this run. */
export interface World {
  readonly button?: string
  readonly extraButtons?: readonly string[]
  readonly home?: string
  /** The first tap on the sign-in button fails in a way that leaves the outcome unknown. */
  readonly flaky?: boolean
}

export function pagesOf(world: World): Record<string, readonly FakeNode[]> {
  const form: FakeNode[] = [
    { role: "heading", name: "Sign in", text: "Sign in" },
    { role: "textbox", name: "Email", label: "Email" },
    ...[world.button ?? "Sign in", ...(world.extraButtons ?? [])].map(
      (name): FakeNode => ({ role: "button", name, text: name }),
    ),
  ]
  return {
    "/": form,
    "/alt": form,
    "/home": [
      { role: "heading", name: world.home ?? "Home", text: world.home ?? "Home" },
      { role: "button", name: "Sign out", text: "Sign out" },
    ],
  }
}

export function worldEngine(world: World) {
  let failed = false
  return fakeEngine({
    pages: pagesOf(world),
    onAct(node, action) {
      if (action.kind !== "tap" || node.name === "Sign out") return undefined
      if (world.flaky === true && !failed) {
        failed = true
        throw new E2EError("NAVIGATION_FAILED", "the page did not say whether it navigated")
      }
      return "/home"
    },
  })
}

/** Plays the part of a recorded model: reads the outline it is given and finishes the sign-in. */
export function solver(
  requests: ModelRequest[] = [],
): E2EModel & { readonly requests: ModelRequest[] } {
  return {
    requests,
    decide(request) {
      requests.push(request)
      if (request.kind !== "act") throw new Error(`unexpected ${request.kind} request`)
      const taken = request.history.filter((entry) => entry.ok).map((entry) => entry.action.kind)
      if (!taken.includes("fill") && request.snapshot.includes('textbox "Email"')) {
        return { kind: "fill", target: { label: "Email" }, value: "{email}" }
      }
      if (!taken.includes("tap")) {
        const named = /button "(Sign in|Log in)"/.exec(request.snapshot)
        const retry = request.history.some((entry) => !entry.ok)
        if (named?.[1] !== undefined) {
          const target: { role: string; name: string; exact?: boolean } = {
            role: "button",
            name: named[1],
          }
          if (retry) target.exact = true
          return { kind: "tap", target }
        }
      }
      return { kind: "done", summary: "signed in" }
    },
  }
}

export function refusing(): E2EModel & { calls: number } {
  const model = {
    calls: 0,
    decide(): never {
      model.calls += 1
      throw new Error("the model should not have been asked")
    },
  }
  return model
}

export function lastAct(requests: readonly ModelRequest[]): ActRequest | undefined {
  const found = requests.filter((request): request is ActRequest => request.kind === "act")
  return found[found.length - 1]
}
