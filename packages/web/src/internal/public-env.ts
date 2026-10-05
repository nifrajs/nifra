export function publicEnvDefines(
  prefix: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const defines: Record<string, string> = {}
  if (prefix === "") return defines // opt-out: bake in nothing
  for (const [name, value] of Object.entries(env)) {
    // Skip `undefined` (a deleted/unset key can still enumerate) so we never bake in `"undefined"`.
    if (name.startsWith(prefix) && value !== undefined) {
      defines[`process.env.${name}`] = JSON.stringify(value)
    }
  }
  return defines
}
