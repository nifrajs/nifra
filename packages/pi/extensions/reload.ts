/**
 * Tiny Pi RPC compatibility bridge.
 *
 * Pi exposes reload through the interactive `/reload` command, while its JSONL RPC command union
 * intentionally has no top-level `reload` command. Registering the same command through the public
 * extension API makes `/reload` available to RPC hosts without importing Pi internals.
 */
export default function registerNifraReloadBridge(pi: {
  registerCommand: (
    name: string,
    options: {
      readonly description?: string
      readonly handler: (
        args: string,
        context: { readonly reload: () => Promise<void> },
      ) => Promise<void>
    },
  ) => void
}) {
  pi.registerCommand("reload", {
    description: "Reload Pi extensions and resources",
    handler: async (_args, context) => {
      await context.reload()
    },
  })
}
