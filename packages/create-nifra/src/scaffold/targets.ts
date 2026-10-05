/**
 * Where a site deploys. A scaffold picks ONE target (`--target`, default `bun`): `nifra build` generates
 * that target's server entry from `backend/` and `routes/`, so the app carries no per-runtime entry or
 * build script - only the target's own config file, when it has one, and the scripts that run it.
 * `nifra target <t>` switches it later.
 */

export const DEPLOY_TARGETS = ["bun", "node", "deno", "cloudflare", "vercel"] as const
export type DeployTarget = (typeof DEPLOY_TARGETS)[number]

export interface TargetSpec {
  readonly label: string
  /** `start` script: run the built app locally. */
  readonly start?: string
  /** `deploy` script. Self-hosted targets have none unless the app is built into a Docker image. */
  readonly deploy?: string
  /** `@nifrajs/*` packages the generated server entry imports beyond the shared set. */
  readonly runtime?: readonly string[]
  /** Whether `--docker` applies: a self-hosting server, not a platform's own runtime. */
  readonly docker: boolean
}

export const TARGETS: Readonly<Record<DeployTarget, TargetSpec>> = {
  bun: { label: "Bun", start: "bun dist/server.js", docker: true },
  node: { label: "Node", start: "node dist/server.js", runtime: ["node"], docker: true },
  deno: {
    label: "Deno Deploy",
    start: "deno run --allow-net --allow-read --allow-env dist/server.js",
    deploy: "deployctl deploy --prod --entrypoint=dist/server.js",
    docker: false,
  },
  cloudflare: {
    label: "Cloudflare Pages",
    // `pages dev` is only ever one local process - the single instance the memory rate limit allows.
    start: "wrangler pages dev dist --binding NIFRA_ALLOW_MEMORY_RATE_LIMIT=true",
    deploy: "wrangler pages deploy dist",
    docker: false,
  },
  vercel: { label: "Vercel", deploy: "vercel deploy --prebuilt", docker: false },
}

export function isDeployTarget(value: string): value is DeployTarget {
  return (DEPLOY_TARGETS as readonly string[]).includes(value)
}

/**
 * The project name as a platform knows the app: a Docker image tag and a Cloudflare Pages or Deno Deploy
 * project name take lowercase letters, digits, and "-", where the project itself may be `MyApp`,
 * `my_app`, or `my.app`.
 */
export function deployName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "")
}

/** The `deploy` script for `target`, or `undefined` when there is none. */
export function deployScript(
  target: DeployTarget,
  name: string,
  docker: boolean,
): string | undefined {
  const image = deployName(name)
  return docker
    ? `docker build -t ${image} . && docker run -p 3000:3000 ${image}`
    : TARGETS[target].deploy
}

/** The image a Docker scaffold runs the built server in. */
const DOCKER_RUN: Readonly<Record<"bun" | "node", { image: string; user: string; cmd: string }>> = {
  bun: { image: "oven/bun:1-slim", user: "bun", cmd: '["bun", "dist/server.js"]' },
  node: { image: "node:22-slim", user: "node", cmd: '["node", "dist/server.js"]' },
}

/** A Dockerfile that builds with Bun and runs the self-contained `dist/` on the target's runtime. */
export function renderDockerfile(target: "bun" | "node"): string {
  const run = DOCKER_RUN[target]
  return `# Build with Bun (nifra's build toolchain), then run the self-contained bundle - the final image
# carries no build tools or node_modules.
#   docker build -t my-nifra-app .
#   docker run -p 3000:3000 my-nifra-app
FROM oven/bun:1 AS build
WORKDIR /app
# Copy manifests first so the install layer caches across source-only changes.
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build

FROM ${run.image} AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/dist ./dist
# The bundle needs no elevated privileges; a compromised request handler should not inherit root.
USER ${run.user}
EXPOSE 3000
CMD ${run.cmd}
`
}

export const DOCKERIGNORE = `node_modules
dist
.nifra
.nifra-build
.vercel
.wrangler
.git
*.log
`

/** `deno.json` for the Deno target: Bun builds, Deno runs and deploys the bundle. */
export const DENO_JSON = `${JSON.stringify(
  {
    tasks: { start: TARGETS.deno.start },
    "//": "Build with Bun (`bun run build`), run the self-contained bundle on Deno. Deploy: deployctl deploy --prod --entrypoint=dist/server.js",
  },
  null,
  2,
)}\n`

/** `wrangler.toml` for the Cloudflare target; `NAME` is the Pages project. */
export const WRANGLER_TOML = `name = "NAME"
pages_build_output_dir = "dist"
# 2025-04-01 or later: from that date \`nodejs_compat\` fills \`process.env\` from the project's variables,
# where backend/app.ts reads NIFRA_ALLOW_MEMORY_RATE_LIMIT; until that variable is "true" the worker
# refuses to start. Set it (a Pages variable, or a [vars] table here) only if a per-isolate rate limit
# will do: Cloudflare runs many isolates and each counts alone. \`bun run start\` sets it for its one
# local process.
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
`

/** The config files `target` needs at the app root, by name. */
export function targetFiles(
  target: DeployTarget,
  name: string,
  docker: boolean,
): Map<string, string> {
  const files = new Map<string, string>()
  if (target === "deno") files.set("deno.json", DENO_JSON)
  if (target === "cloudflare")
    files.set("wrangler.toml", WRANGLER_TOML.replace("NAME", deployName(name)))
  if (docker && (target === "bun" || target === "node")) {
    files.set("Dockerfile", renderDockerfile(target))
    files.set(".dockerignore", DOCKERIGNORE)
  }
  return files
}
