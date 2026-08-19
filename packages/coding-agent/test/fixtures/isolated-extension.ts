export default function isolated(context: {
  readonly registerTool: (tool: {
    readonly name: string
    readonly description: string
    readonly execute: (input: unknown) => unknown
  }) => void
}) {
  context.registerTool({
    name: "echo",
    description: "Echo a bounded input",
    execute: (input) => input,
  })
}
