import type { DeploymentAdapterContext, DeploymentTargetAdapter } from "@nifrajs/web/build"

/** The options a project passes; only `app` is required. */
interface FlyOptions {
  readonly app: string
  readonly primaryRegion?: string
  readonly internalPort?: number
  readonly forceHttps?: boolean
  readonly healthCheckPath?: string
  readonly image?: string
}

interface ResolvedFlyOptions {
  readonly [key: string]: unknown
  readonly app: string
  readonly primaryRegion?: string
  readonly internalPort: number
  readonly forceHttps: boolean
  readonly healthCheckPath?: string
  readonly image: string
}

const DEFAULT_IMAGE = "node:22-slim"
// A registry path, then an optional tag and/or digest; no whitespace, so it cannot add Dockerfile lines.
const IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?(?:@sha256:[a-f0-9]{64})?$/

/** Parse the Fly-specific settings and fill defaults before Nifra begins a build. */
function parseOptions(input: unknown): ResolvedFlyOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("[nifra/deploy-fly] options must be an object with an `app` name")
  const values = new Map<string, unknown>()
  for (const [key, value] of Object.entries(input)) values.set(key, value)
  const allowed = new Set([
    "app",
    "primaryRegion",
    "internalPort",
    "forceHttps",
    "healthCheckPath",
    "image",
  ])
  const unknown = [...values.keys()].filter((key) => !allowed.has(key))
  if (unknown.length > 0)
    throw new Error(`[nifra/deploy-fly] unknown option(s): ${unknown.join(", ")}`)
  const app = values.get("app")
  if (typeof app !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app))
    throw new Error(
      "[nifra/deploy-fly] `app` must be a Fly app name using lowercase letters, digits, and hyphens",
    )
  const primaryRegion = values.get("primaryRegion")
  if (
    primaryRegion !== undefined &&
    (typeof primaryRegion !== "string" || !/^[a-z0-9-]{2,16}$/.test(primaryRegion))
  )
    throw new Error("[nifra/deploy-fly] `primaryRegion` must be a Fly region code such as `iad`")
  const internalPort = values.get("internalPort") ?? 3000
  if (
    typeof internalPort !== "number" ||
    !Number.isInteger(internalPort) ||
    internalPort < 1 ||
    internalPort > 65535
  )
    throw new Error("[nifra/deploy-fly] `internalPort` must be an integer between 1 and 65535")
  const forceHttps = values.get("forceHttps") ?? true
  if (typeof forceHttps !== "boolean")
    throw new Error("[nifra/deploy-fly] `forceHttps` must be a boolean")
  const image = values.get("image") ?? DEFAULT_IMAGE
  if (typeof image !== "string" || image.length > 200 || !IMAGE_REFERENCE.test(image))
    throw new Error(
      "[nifra/deploy-fly] `image` must be a container image reference such as `node:22-slim` or `node@sha256:<digest>`",
    )
  const healthCheckPath = values.get("healthCheckPath")
  if (healthCheckPath !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = new URL(String(healthCheckPath), "http://nifra.invalid")
    } catch {
      // The validation below reports one actionable error for malformed and non-path values.
    }
    if (
      typeof healthCheckPath !== "string" ||
      !healthCheckPath.startsWith("/") ||
      healthCheckPath.startsWith("//") ||
      parsed?.origin !== "http://nifra.invalid" ||
      parsed.pathname !== healthCheckPath ||
      parsed.search !== "" ||
      parsed.hash !== ""
    )
      throw new Error(
        "[nifra/deploy-fly] `healthCheckPath` must be a same-origin path such as `/healthz`",
      )
  }
  const normalized: {
    app: string
    primaryRegion?: string
    internalPort: number
    forceHttps: boolean
    healthCheckPath?: string
    image: string
  } = {
    app,
    internalPort,
    forceHttps,
    image,
  }
  if (primaryRegion !== undefined) normalized.primaryRegion = primaryRegion
  if (healthCheckPath !== undefined) normalized.healthCheckPath = healthCheckPath
  return normalized
}

/** Render validated options as a Fly HTTP service manifest. */
function flyToml(options: ResolvedFlyOptions): string {
  return [
    `app = ${JSON.stringify(options.app)}`,
    ...(options.primaryRegion !== undefined
      ? [`primary_region = ${JSON.stringify(options.primaryRegion)}`]
      : []),
    "",
    "[http_service]",
    `  internal_port = ${options.internalPort}`,
    `  force_https = ${options.forceHttps}`,
    ...(options.healthCheckPath === undefined
      ? []
      : [
          "",
          "[[http_service.checks]]",
          '  grace_period = "10s"',
          '  interval = "30s"',
          '  method = "GET"',
          '  timeout = "5s"',
          `  path = ${JSON.stringify(options.healthCheckPath)}`,
        ]),
    "",
  ].join("\n")
}

/** Render a non-root Node image whose listener port matches the Fly service configuration. */
function dockerfile(options: ResolvedFlyOptions): string {
  return [
    `FROM ${options.image}`,
    "ENV NODE_ENV=production",
    `ENV PORT=${options.internalPort}`,
    "WORKDIR /app",
    "COPY --chown=node:node . .",
    "USER node",
    `EXPOSE ${options.internalPort}`,
    'CMD ["node", "server.js"]',
    "",
  ].join("\n")
}

export const flyAdapter: DeploymentTargetAdapter = {
  apiVersion: 1,
  id: "fly",
  baseTarget: "node",
  capabilities: { componentPipeline: false },
  validateOptions: parseOptions,
  /** Return deploy files and guidance without performing provider I/O. */
  emit(context: DeploymentAdapterContext) {
    const options = parseOptions(context.options)
    return {
      files: [
        { path: "Dockerfile", contents: dockerfile(options) },
        { path: "fly.toml", contents: flyToml(options) },
      ],
      run: "fly deploy",
    }
  },
}

export type { FlyOptions }
