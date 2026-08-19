import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExtensionHost, validateExtensionModule } from "@nifrajs/coding-agent"

const cwd = await mkdtemp(join(tmpdir(), "nifra-self-extension-demo-"))
try {
  const path = join(cwd, "route-assurance.ts")
  await writeFile(
    path,
    `export default ({ registerCommand }) => registerCommand("route-assurance", () => ({ panel: "v1", verified: true }))`,
  )
  const host = new ExtensionHost({
    cwd,
    roots: ["route-assurance.ts"],
    validate: validateExtensionModule,
  })
  const first = await host.reload()
  const firstPanel = await host.command("route-assurance")?.("", {
    cwd,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerWorkflow: () => undefined,
    registerSubagent: () => undefined,
    registerProvider: () => undefined,
    on: () => undefined,
  })
  await writeFile(
    path,
    `export default ({ registerCommand }) => registerCommand("route-assurance", () => ({ panel: "v2", verified: true, hotReloaded: true }))`,
  )
  const second = await host.reload()
  const secondPanel = await host.command("route-assurance")?.("", {
    cwd,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    registerWorkflow: () => undefined,
    registerSubagent: () => undefined,
    registerProvider: () => undefined,
    on: () => undefined,
  })
  console.log(
    JSON.stringify({
      created: first.rolledBack === false,
      reloaded: second.rolledBack === false,
      firstPanel,
      secondPanel,
      revision: second.revision,
    }),
  )
  await host.close()
} finally {
  await rm(cwd, { recursive: true, force: true })
}
