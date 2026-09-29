import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"

import { isReleaseBranch, pendingChangesetFiles } from "./release-branch.ts"

const run = (command: string, args: readonly string[], encoding?: BufferEncoding): string => {
  if (encoding === undefined) {
    execFileSync(command, [...args], { stdio: "inherit" })
    return ""
  }
  return execFileSync(command, [...args], { encoding })
}

const branch = run("git", ["branch", "--show-current"], "utf8").trim()
if (!isReleaseBranch(branch))
  throw new Error("release:prepare must run on a branch named release/<name>")

if (run("git", ["status", "--porcelain=v1"], "utf8").trim().length > 0)
  throw new Error("release:prepare requires a clean working tree")

if (!existsSync(".changeset")) throw new Error("release:prepare requires a .changeset directory")
const changesets = pendingChangesetFiles(readdirSync(".changeset"))
if (changesets.length === 0)
  throw new Error("release:prepare found no pending changesets; run `bun run changeset` first")

console.log(`Preparing ${branch} from ${changesets.length} pending changeset(s).`)
run("bun", ["run", "changeset:version"])
console.log("Release versions and generated artifacts are ready to commit on this branch.")
