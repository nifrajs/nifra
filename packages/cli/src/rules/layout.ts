import { retiredRootFiles } from "../app-files.ts"
import { diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"

/** Every gate that reads backend/app.ts sees nothing in a retired root file, so the check fails here. */
export const retiredLayoutRule: CheckRule = {
  code: "NF-C038",
  title: "Retired root layout",
  async scan(ctx) {
    return retiredRootFiles(ctx.root).map(([from, to]) =>
      diagnostic({
        code: "NF-C038",
        severity: "error",
        file: from,
        line: 1,
        message: `${from} is the retired root layout; nifra reads it at ${to}. Until it moves, nifra check runs no contract gate on this app, and the commands that load it refuse it. \`nifra migrate layout\` shows the move; \`--write\` makes it`,
        fix: { recipe: "layout.migrate", command: "nifra migrate layout --write" },
        verify: "nifra check --lints-only",
      }),
    )
  },
}
