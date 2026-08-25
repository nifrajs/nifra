export default function isolated(context: {
  readonly registerTool: (tool: {
    readonly name: string
    readonly description: string
    readonly execute: (input: unknown) => unknown
  }) => void
}) {
  context.registerTool({
    name: "fail",
    description: "Throw a diagnostic error",
    execute: () => {
      throw new Error("extension diagnostic")
    },
  })
}
