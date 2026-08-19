# Nifra agent extensions

Extensions are project-local TypeScript modules under `.nifra/extensions/`. They are discovered
only when the host is configured for that project; no dependency or home-directory scan is implicit.

```ts
export const capabilities = ["filesystem.read"] as const

export default ({ registerCommand, registerWorkflow }) => {
  registerCommand("status", async (_args, context) => ({ cwd: context.cwd }))
  registerWorkflow("verify", () => ({
    type: "verify",
    id: "check",
    run: async () => true,
  }))
}
```

The host syntax-checks a changed module, stages a complete replacement graph, and only then
disposes the previous graph. A failed load leaves the last known-good graph active. Extensions can
declare capabilities, but untrusted capabilities are rejected before registration. Workflows run
with bounded step and depth ceilings through `workflow.run`.

Use `nifra-agent` `/reload` or the Workbench preview/activate controls after the file is saved.
The stable Workbench shell, approval UX, and token boundary are not replaceable by an extension.
