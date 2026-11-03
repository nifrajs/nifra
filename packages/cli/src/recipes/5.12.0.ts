import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.12.
 *
 * This release has no import or dependency moves. Its notes cover the opt-in static response lane,
 * schema validation and coercion changes, shared body limits, and WebSocket topic adapters.
 */
export const recipe: UpgradeRecipe = {
  version: "5.12.0",
  pins: [
    { match: "@nifrajs/", to: "5.12.0" },
    { match: "create-nifra", to: "5.12.0" },
    { match: "nifra", to: "5.12.0" },
  ],
  importMoves: [],
  affects: [
    "@nifrajs/core",
    "@nifrajs/deno",
    "@nifrajs/edge",
    "@nifrajs/node",
    "@nifrajs/schema",
    "@nifrajs/web",
  ],
  notes: [
    "`staticResponse()` registers fixed, bodyless GET/HEAD routes. Eligible Bun listeners serve them directly from Bun's route table; existing routes are unchanged unless they opt in.",
    "Capability IDs now allow `_` separators, so grants work for IDs derived from snake_case `defineTool` names. Names with empty segments still need an explicit valid capability.",
    "Server apps can provide a WebSocket `TopicAdapter`. The Node and Deno adapters report topic cleanup failures without skipping close callbacks.",
    "Core exports its default request-body cap for the edge kit, and the core and edge servers now use the same default.",
    "Schema validation treats inherited `Object.prototype` members as absent unless the input has that own key. Optional keys such as `constructor` no longer cause false validation failures; coercing schemas validate and return a prototype-free copy without mutating a plain-object input.",
    "`compileSchema()` output works with strict TypeScript, `noUnusedLocals`, `noUnusedParameters`, and Node's built-in type stripping. It also rejects schema text containing a type annotation Node cannot strip.",
    "The schema coercion fast path now covers scalar arrays and primitive literal unions. Ordinary loader contexts also use shallow copies while specialized contexts retain lazy request accessors.",
    "Common routes that combine validated HTTP inputs and lifecycle hooks now use the compiled fast path, preserving their route behavior.",
  ],
}
