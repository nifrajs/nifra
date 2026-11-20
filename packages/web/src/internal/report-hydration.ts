import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { RouteEntry } from "../manifest.ts"
import { type Token, tokenize } from "./private-env.ts"

type Hydration = boolean | "unknown"

const idIs = (token: Token | undefined, value: string): boolean =>
  token?.kind === "id" && token.value === value
const punctIs = (token: Token | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value

/** Read literal route settings without running a backend module at build time. */
function reportedHydration(file: string): Hydration {
  const source = readFileSync(file, "utf8")
  const compiler = new Bun.Transpiler({ loader: /\.[cm]?ts$/.test(file) ? "ts" : "js" })
  const hasExport = compiler.scan(source).exports.includes("hydrate")
  const tokens = tokenize(source)
  if (!hasExport) {
    // A star export can carry a setting that scan() cannot name from this file.
    return tokens.some((token, i) => idIs(token, "export") && punctIs(tokens[i + 1], "*"))
      ? "unknown"
      : true
  }

  const start = tokens.findIndex(
    (token, i) =>
      idIs(token, "export") && idIs(tokens[i + 1], "const") && idIs(tokens[i + 2], "hydrate"),
  )
  if (start < 0) return "unknown"
  let eq = start + 3
  if (punctIs(tokens[eq], ":") && idIs(tokens[eq + 1], "boolean")) eq += 2
  if (!punctIs(tokens[eq], "=")) return "unknown"
  const literal = tokens[eq + 1]
  if (literal?.kind !== "id" || (literal.value !== "false" && literal.value !== "true")) {
    return "unknown"
  }
  let end = eq + 2
  if (idIs(tokens[end], "as") && idIs(tokens[end + 1], "const")) end += 2
  const next = tokens[end]
  if (next === undefined || punctIs(next, ";") || punctIs(next, ",") || idIs(next, "export")) {
    return literal.value === "true"
  }
  return "unknown"
}

export function clientReportRoutes(routesDir: string, routes: readonly RouteEntry[]) {
  const byBackend = new Map<string, Hydration>()
  return routes.map(({ id, pattern, backend }) => {
    if (backend === undefined) return { id, pattern }
    const hydrate = byBackend.get(backend) ?? reportedHydration(join(routesDir, backend))
    byBackend.set(backend, hydrate)
    return { id, pattern, hydrate }
  })
}
