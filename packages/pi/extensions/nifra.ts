/**
 * Optional Pi extension shipped separately from the adapter runtime.
 * Load it with `--extension` or let PiBackend do so with `enableNifraTools: true`.
 *
 * It deliberately uses Pi's public extension API and the existing `nifra` executable. The
 * framework packages remain unaware of both Pi and this extension.
 */
export default function registerNifraTools(pi: {
  registerTool(tool: {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute: (
      toolCallId: string,
      input: unknown,
      signal: AbortSignal,
    ) => Promise<{
      content: readonly { type: "text"; text: string }[]
      details: Record<string, unknown>
    }>
  }): void
  exec(
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string; readonly signal?: AbortSignal },
  ): Promise<{ readonly stdout?: string; readonly stderr?: string; readonly code: number }>
}) {
  const parameters = { type: "object", properties: {}, additionalProperties: false }
  const register = (name: string, label: string, description: string, args: readonly string[]) => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, _input, signal) => {
        const result = await pi.exec("nifra", args, { cwd: process.cwd(), signal })
        const text =
          result.stdout ||
          result.stderr ||
          (result.code === 0 ? "ok" : `nifra exited with code ${result.code}`)
        return {
          content: [{ type: "text", text }],
          details: { code: result.code, command: ["nifra", ...args].join(" ") },
        }
      },
    })
  }
  register(
    "nifra_context",
    "Nifra context",
    "Inspect the current Nifra project context and typed agent surfaces.",
    ["context"],
  )
  register(
    "nifra_check",
    "Nifra check",
    "Run the Nifra typed contract check and return structured diagnostics.",
    ["check", "--json"],
  )
  register(
    "nifra_assure",
    "Nifra assurance",
    "Run Nifra capability assurance and return structured diagnostics.",
    ["assure", "--json"],
  )
  register("nifra_test", "Nifra test", "Run the configured Nifra test command.", ["test"])
}
