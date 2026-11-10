/** Argument parsing and report for `nifra shell <kind>`. The files come from `./shell-init.ts`. */
import { runShellInit, SHELL_DIST, TRANSPORT_PATH } from "./shell-init.ts"

const VALUE_FLAGS = new Set(["--origin", "--name", "--id"])

export async function runShellCommand(cwd: string, args: readonly string[]): Promise<number> {
  const [kind, ...rest] = args
  if (kind !== "tauri") {
    console.error("[nifra] shell needs a kind: `nifra shell tauri`")
    return 1
  }
  const values: Record<string, string> = {}
  let force = false
  let json = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) break
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (VALUE_FLAGS.has(name)) {
      const value = equals === -1 ? rest[++i] : arg.slice(equals + 1)
      if (value === undefined || value === "" || (equals === -1 && value.startsWith("-"))) {
        console.error(`[nifra] ${name} needs a value`)
        return 1
      }
      values[name] = value
    } else if (name === "--force") force = true
    else if (name === "--json") json = true
    else {
      console.error(`[nifra] unknown option: ${arg} - see \`nifra help\``)
      return 1
    }
  }
  try {
    const result = await runShellInit(cwd, {
      origin: values["--origin"],
      name: values["--name"],
      id: values["--id"],
      force,
    })
    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    for (const file of result.files) {
      console.log(`${file.action.padEnd(8)} ${file.path}${file.note ? `  (${file.note})` : ""}`)
    }
    console.log(
      `
Server origin ${result.origin}, bundle id ${result.id} (change both if they are not yours).
Next:
  1. Add the Tauri CLI:        bun add -d @tauri-apps/cli
  2. Make an icon set:         bunx tauri icon path/to/icon.png
  3. Allow the shell on the server: list tauri://localhost and http://tauri.localhost in its CORS,
     route \`allowedOrigins\`, \`serverFunctions\` \`origins\` and \`live\` \`trustedOrigins\`
     (https://nifra.dev/docs/native-shells).
  4. Prerender the pages a shell opens on: \`export const prerender = true\` in a route's .backend.ts.
  5. Run:                      bunx tauri dev      (or \`bunx tauri build\`; the page build lands in ${SHELL_DIST}/)
The transport lives in ${TRANSPORT_PATH}; the web build of this app does not use it.`,
    )
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
