import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  changedPublicPackageVersions,
  isReleaseBranch,
  pendingChangesetFiles,
  releaseCheckBaseRef,
} from "./release-branch.ts"

describe("release branch policy", () => {
  test("accepts bounded release branch names only", () => {
    expect(isReleaseBranch("release/2026-09-29")).toBe(true)
    expect(isReleaseBranch("release/v3.6.0")).toBe(true)
    expect(isReleaseBranch("main")).toBe(false)
    expect(isReleaseBranch("release/")).toBe(false)
    expect(isReleaseBranch("release/../main")).toBe(false)
  })

  test("identifies pending changesets without treating README as a release entry", () => {
    expect(pendingChangesetFiles(["README.md", "config.json", "zeta.md", "alpha.md"])).toEqual([
      "alpha.md",
      "zeta.md",
    ])
  })

  test("requires a changed version on a public package", () => {
    const base = [
      { name: "@nifrajs/core", version: "3.5.0" },
      { name: "private-tool", version: "3.5.0", private: true },
    ]
    expect(
      changedPublicPackageVersions(base, [
        { name: "@nifrajs/core", version: "3.5.1" },
        { name: "private-tool", version: "3.5.1", private: true },
      ]),
    ).toEqual([{ name: "@nifrajs/core", baseVersion: "3.5.0", releaseVersion: "3.5.1" }])
  })

  test("requires the associated pull request base SHA for merge checks", () => {
    const baseSha = "a".repeat(40)
    expect(releaseCheckBaseRef(true, baseSha, "ignored")).toBe(baseSha)
    expect(() => releaseCheckBaseRef(true, undefined, "ignored")).toThrow(
      "RELEASE_BASE_SHA to be a full commit SHA",
    )
    expect(() => releaseCheckBaseRef(true, "main", "ignored")).toThrow(
      "RELEASE_BASE_SHA to be a full commit SHA",
    )
    expect(releaseCheckBaseRef(false, undefined, "base-sha")).toBe("base-sha")
  })
})

test("release workflow verifies release PRs and never invokes Version Packages automation", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  )
  expect(workflow).toContain("startsWith(github.event.pull_request.head.ref, 'release/')")
  expect(workflow).toContain("github.event_name != 'pull_request' && 'publish'")
  expect(workflow).toContain("queue: max")
  expect(workflow).toContain('.name == "release-verification"')
  expect(workflow).toContain("bun run release:check")
  expect(workflow).toContain("bun run changeset:publish")
  expect(workflow).not.toContain("changesets/action@")
})

test("release verification provisions the runtimes its gates run and leaves timing to the local run", () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
  const release = read("release.yml")
  const job = release.slice(
    release.indexOf("\n  verify-release-pr:"),
    release.indexOf("\n  prove-release:"),
  )
  const ci = read("ci.yml")
  expect(job).toContain("bun run verify:release --shared-runner")
  for (const pin of [
    /denoland\/setup-deno@\w+\s+with:\s+deno-version: \S+/,
    /actions\/setup-node@\w+\s+with:\s+node-version: \S+/,
  ]) {
    expect(job.match(pin)?.[0]).toBe(ci.match(pin)?.[0] ?? "missing from ci.yml")
  }
})

interface WorkflowStep {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Readonly<Record<string, unknown>>
  readonly env?: Readonly<Record<string, unknown>>
}

interface WorkflowJob {
  readonly if?: string
  readonly needs?: string | readonly string[]
  readonly environment?: unknown
  readonly permissions?: Readonly<Record<string, string>>
  readonly steps?: readonly WorkflowStep[]
}

// Windows checks the workflows out with CRLF line endings.
const workflowText = (name: string): string =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  )

const workflowJobs = (name: string): Readonly<Record<string, WorkflowJob | undefined>> =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a checked-in workflow; a field it lacks reads undefined and fails the assertion on it
  (Bun.YAML.parse(workflowText(name)) as { jobs: Record<string, WorkflowJob> }).jobs

const setupNode = (job: WorkflowJob | undefined): WorkflowStep | undefined =>
  job?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"))

const NPM_GATE = "Check npm can publish through trusted publishing"

test("npm publishes through trusted publishing, and only a proven release holds that identity", () => {
  expect(workflowText("release.yml")).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/)
  const jobs = workflowJobs("release.yml")
  const { publish } = jobs
  expect(publish?.needs).toBe("prove-release")
  expect(publish?.if).toBe("needs.prove-release.outputs.is_release == 'true'")
  expect(publish?.environment).toBe("npm-publish")
  expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" })
  for (const [id, job] of Object.entries(jobs)) {
    if (id === "publish") continue
    expect({ id, environment: job?.environment, idToken: job?.permissions?.["id-token"] }).toEqual({
      id,
      environment: undefined,
      idToken: undefined,
    })
  }
  const node = setupNode(publish)
  const ciNode = Object.values(workflowJobs("ci.yml")).map(setupNode).find(Boolean)
  expect(node?.uses).toBe(ciNode?.uses ?? "missing from ci.yml")
  expect(node?.with?.["node-version"]).toBe(ciNode?.with?.["node-version"])
  expect(node?.with?.["registry-url"]).toBe("https://registry.npmjs.org")
  const names = publish?.steps?.map((step) => step.name) ?? []
  expect(names.indexOf(NPM_GATE)).toBeGreaterThan(names.indexOf(node?.name))
  expect(names.indexOf(NPM_GATE)).toBeLessThan(names.indexOf("Publish versioned packages"))
})

test("the job that can publish runs no install script and nothing after the publish", () => {
  const { publish, "deploy-site": deploy } = workflowJobs("release.yml")
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const installs = (publish?.steps ?? []).filter((step) => step.run?.includes("bun install"))
  expect(installs.map((step) => step.run?.trim().split("\n"))).toEqual([
    ["bun install --frozen-lockfile --ignore-scripts", scripts.postinstall],
  ])
  expect(publish?.steps?.at(-1)?.name).toBe("Publish versioned packages")
  // The registry smoke test and the wrangler deploy run after a publish, in a job without the identity.
  expect(deploy?.needs).toEqual(["prove-release", "publish"])
  expect(deploy?.steps?.map((step) => step.name)).toEqual(
    expect.arrayContaining([
      "Smoke test published registry packages",
      "Deploy site to Cloudflare Pages",
      "Probe production site",
    ]),
  )
})

test.skipIf(process.platform === "win32")(
  "the publish stops before it runs an npm too old for trusted publishing",
  () => {
    const gate =
      workflowJobs("release.yml").publish?.steps?.find((step) => step.name === NPM_GATE)?.run ?? ""
    expect(gate).not.toBe("")
    const dir = mkdtempSync(join(tmpdir(), "release-npm-gate-"))
    try {
      const npm = join(dir, "npm")
      const outcomes = ["10.9.2", "11.5.0", "11.5.1", "11.12.0", "12.0.0"].map((version) => {
        writeFileSync(npm, `#!/bin/sh\necho ${version}\n`)
        chmodSync(npm, 0o755)
        const run = Bun.spawnSync(["bash", "-c", gate], {
          env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
        })
        return `${version} ${run.exitCode === 0 ? "publishes" : "stops"}`
      })
      expect(outcomes).toEqual([
        "10.9.2 stops",
        "11.5.0 stops",
        "11.5.1 publishes",
        "11.12.0 publishes",
        "12.0.0 publishes",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

const releaseStep = (job: string, name: string): string =>
  workflowJobs("release.yml")[job]?.steps?.find((step) => step.name === name)?.run ?? ""

/** Writes `files` as executables into `dir`/bin; the PATH returned finds them before anything real. */
const fakeBin = (dir: string, files: Readonly<Record<string, string>>): string => {
  const bin = join(dir, "bin")
  mkdirSync(bin)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  return `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`
}

const NPM_WAIT = "Wait for npm to serve the published versions"

test.skipIf(process.platform === "win32" || Bun.which("jq") === null)(
  "the smoke test waits until npm serves every published version",
  () => {
    const names = workflowJobs("release.yml")["deploy-site"]?.steps?.map((step) => step.name) ?? []
    expect(names.indexOf(NPM_WAIT)).toBeGreaterThan(-1)
    expect(names.indexOf(NPM_WAIT)).toBeLessThan(
      names.indexOf("Smoke test published registry packages"),
    )
    const dir = mkdtempSync(join(tmpdir(), "release-npm-wait-"))
    try {
      for (const [folder, manifest] of Object.entries({
        scoped: { name: "@scope/scoped", version: "2.0.0" },
        plain: { name: "plain", version: "2.0.0" },
        internal: { name: "internal", version: "9.9.9", private: true },
      })) {
        mkdirSync(join(dir, "packages", folder), { recursive: true })
        writeFileSync(join(dir, "packages", folder, "package.json"), JSON.stringify(manifest))
      }
      const served = join(dir, "served")
      // npm serves 2.0.0 once `served` exists, which the wait between rounds creates under PROPAGATE.
      const PATH = fakeBin(dir, {
        curl: `#!/bin/sh\necho "$*" >> "${join(dir, "curl.log")}"\nif [ -e "${served}" ]; then echo '{"versions":{"1.0.0":{},"2.0.0":{}}}'; else echo '{"versions":{"1.0.0":{}}}'; fi\n`,
        sleep: `#!/bin/sh\nif [ -n "$PROPAGATE" ]; then touch "${served}"; fi\n`,
      })
      const run = (env: Record<string, string>) =>
        Bun.spawnSync(["bash", "-c", releaseStep("deploy-site", NPM_WAIT)], {
          cwd: dir,
          env: { HOME: dir, PATH, ...env },
        })
      const stalled = run({})
      expect(stalled.exitCode).toBe(1)
      for (const spec of ["@scope/scoped@2.0.0", "plain@2.0.0"])
        expect(stalled.stderr.toString()).toContain(spec)
      expect(run({ PROPAGATE: "1" }).exitCode).toBe(0)
      const calls = readFileSync(join(dir, "curl.log"), "utf8")
      expect(calls).toContain("https://registry.npmjs.org/@scope%2fscoped")
      expect(calls).not.toContain("internal")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

const DEPLOY = "Deploy site to Cloudflare Pages"
const PROBE = "Probe production site"

test.skipIf(process.platform === "win32")(
  "the deployment carries its own stamp, written before wrangler deploys the site",
  () => {
    const steps = workflowJobs("release.yml")["deploy-site"]?.steps ?? []
    const stamps = [DEPLOY, PROBE].map(
      (name) => steps.find((step) => step.name === name)?.env?.DEPLOYMENT,
    )
    expect(stamps).toEqual([
      `\${{ github.run_id }}.\${{ github.run_attempt }}`,
      `\${{ github.run_id }}.\${{ github.run_attempt }}`,
    ])
    const dir = mkdtempSync(join(tmpdir(), "release-site-deploy-"))
    try {
      mkdirSync(join(dir, "site"))
      const PATH = fakeBin(dir, {
        bun: "#!/bin/sh\nmkdir -p dist/assets\necho built > dist/index.html\n",
        bunx: `#!/bin/sh\ncat dist/assets/deployment.txt > "${join(dir, "deployed.txt")}"\n`,
      })
      const deploy = Bun.spawnSync(["bash", "-e", "-c", releaseStep("deploy-site", DEPLOY)], {
        cwd: join(dir, "site"),
        env: { HOME: dir, PATH, DEPLOYMENT: "2.1" },
      })
      expect(deploy.exitCode).toBe(0)
      expect(readFileSync(join(dir, "deployed.txt"), "utf8")).toBe("2.1\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === "win32")(
  "the site check passes once a healthy nifra.dev serves this deployment's stamp, not just the same pages",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "release-site-probe-"))
    try {
      const live = join(dir, "live")
      // Until `live` exists nifra.dev serves the previous deployment: the same pages and corpus, an older
      // stamp. A wait between rounds makes this deployment live under DEPLOYED.
      const PATH = fakeBin(dir, {
        curl: [
          "#!/bin/sh",
          'for arg; do url="$arg"; done',
          `if [ -e "${live}" ]; then stamp="$DEPLOYMENT"; else stamp="1.1"; fi`,
          'if [ -n "$BROKEN" ]; then title="502 Bad Gateway"; else title="Nifra - the same copy"; fi',
          'case "$url" in',
          '  */assets/deployment.txt) echo "$stamp" ;;',
          '  *) echo "<html><title>$title</title></html>" ;;',
          "esac",
          "",
        ].join("\n"),
        sleep: `#!/bin/sh\nif [ -n "$DEPLOYED" ]; then touch "${live}"; fi\n`,
      })
      const run = (env: Record<string, string>) =>
        Bun.spawnSync(["bash", "-c", releaseStep("deploy-site", PROBE)], {
          cwd: dir,
          env: { HOME: dir, PATH, DEPLOYMENT: "2.1", ...env },
        }).exitCode
      expect(run({})).toBe(1)
      expect(run({ DEPLOYED: "1" })).toBe(0)
      expect(run({ BROKEN: "1" })).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test("a failed publish is retried from main for a merged release SHA, under the same proofs", () => {
  const release = workflowText("release.yml")
  expect(release).toContain("  workflow_dispatch:\n    inputs:\n      merge_sha:")
  const { "prove-release": prove, publish, "deploy-site": deploy } = workflowJobs("release.yml")
  expect(prove?.if).toContain(
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
  )
  const proof = prove?.steps?.find((step) => step.name === "Prove this is a merged release PR")?.run
  for (const check of [
    `compare/\${MERGE_SHA}...main`,
    '(.path | split("@")[0]) == ".github/workflows/ci.yml" and .conclusion == "success"',
    '.name == "release-verification"',
  ])
    expect(proof).toContain(check)
  const merge = `\${{ needs.prove-release.outputs.merge_sha }}`
  for (const job of [publish, deploy])
    expect(job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(
      merge,
    )
  expect(
    publish?.steps?.find((step) => step.run === "bun run release:check --merge")?.env
      ?.RELEASE_HEAD_SHA,
  ).toBe(merge)
  // Every later step reads the validated SHA, not the trigger's.
  expect(release.match(/workflow_run\.head_sha/g)).toHaveLength(1)
})

const GITHUB_RELEASE = "Publish the version's GitHub release"

test("a published version gets its GitHub release from the only job that may write", () => {
  const jobs = workflowJobs("release.yml")
  const release = jobs["github-release"]
  expect(release?.needs).toEqual(["prove-release", "publish"])
  expect(release?.permissions).toEqual({ contents: "write" })
  expect(
    Object.entries(jobs)
      .filter(([, job]) => job?.permissions?.contents === "write")
      .map(([id]) => id),
  ).toEqual(["github-release"])
  const checkout = release?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))
  expect(checkout?.with?.ref).toBe(`\${{ needs.prove-release.outputs.merge_sha }}`)
  expect(checkout?.with?.["persist-credentials"]).toBe(false)
  expect(release?.steps?.filter((step) => step.run?.includes("install"))).toEqual([])
  expect(release?.steps?.find((step) => step.name === GITHUB_RELEASE)?.env?.MERGE_SHA).toBe(
    `\${{ needs.prove-release.outputs.merge_sha }}`,
  )
})

test.skipIf(process.platform === "win32")(
  "the release step creates the version's release once, at the merge, from its notes",
  () => {
    const step = releaseStep("github-release", GITHUB_RELEASE)
    expect(step).not.toBe("")
    const root = fileURLToPath(new URL("..", import.meta.url))
    const { version } = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"))
    const dir = mkdtempSync(join(tmpdir(), "release-github-"))
    try {
      const log = join(dir, "gh.log")
      const PATH = fakeBin(dir, {
        gh: `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1 $2" = "release view" ]; then exit "$VIEW_EXIT"; fi\n`,
      })
      const sha = "a".repeat(40)
      const run = (viewExit: string) =>
        Bun.spawnSync(["bash", "-c", step], {
          cwd: root,
          env: {
            HOME: dir,
            PATH,
            GH_TOKEN: "test",
            MERGE_SHA: sha,
            REPOSITORY: "nifrajs/nifra",
            RUNNER_TEMP: dir,
            VIEW_EXIT: viewExit,
          },
        })
      // A rerun finds the release a first run made and leaves it alone.
      expect(run("0").exitCode).toBe(0)
      expect(readFileSync(log, "utf8")).not.toContain("release create")
      expect(run("1").exitCode).toBe(0)
      const notes = join(dir, "release-notes.md")
      expect(readFileSync(log, "utf8").trim().split("\n").at(-1)).toBe(
        `release create v${version} --repo nifrajs/nifra --target ${sha} --title v${version} --notes-file ${notes}`,
      )
      expect(readFileSync(notes, "utf8")).toStartWith(
        `All public packages are released together at ${version}.`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
