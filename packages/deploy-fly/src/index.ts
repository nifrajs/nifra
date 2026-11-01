import type { DeploymentAdapterContext, DeploymentTargetAdapter } from "@nifrajs/web/build"

interface FlyOptions {
  readonly [key: string]: unknown
  readonly app: string
  readonly primaryRegion?: string
  readonly internalPort: number
  readonly forceHttps: boolean
  readonly healthCheckPath?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseOptions(input: unknown): FlyOptions {
  if (!isRecord(input))
    throw new Error("[nifra/deploy-fly] options must be an object with an `app` name")
  const allowed = new Set(["app", "primaryRegion", "internalPort", "forceHttps", "healthCheckPath"])
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknown.length > 0)
    throw new Error(`[nifra/deploy-fly] unknown option(s): ${unknown.join(", ")}`)
  const app = input.app
  if (typeof app !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app))
    throw new Error(
      "[nifra/deploy-fly] `app` must be a Fly app name using lowercase letters, digits, and hyphens",
    )
  const primaryRegion = input.primaryRegion
  if (
    primaryRegion !== undefined &&
    (typeof primaryRegion !== "string" || !/^[a-z0-9-]{2,16}$/.test(primaryRegion))
  )
    throw new Error("[nifra/deploy-fly] `primaryRegion` must be a Fly region code such as `iad`")
  const internalPort = input.internalPort ?? 3000
  if (
    typeof internalPort !== "number" ||
    !Number.isInteger(internalPort) ||
    internalPort < 1 ||
    internalPort > 65535
  )
    throw new Error("[nifra/deploy-fly] `internalPort` must be an integer between 1 and 65535")
  const forceHttps = input.forceHttps ?? true
  if (typeof forceHttps !== "boolean")
    throw new Error("[nifra/deploy-fly] `forceHttps` must be a boolean")
  const healthCheckPath = input.healthCheckPath
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
  return {
    app,
    ...(primaryRegion !== undefined ? { primaryRegion } : {}),
    internalPort,
    forceHttps,
    ...(healthCheckPath !== undefined ? { healthCheckPath } : {}),
  }
}

function optionsOf(options: Readonly<Record<string, unknown>>): FlyOptions {
  return parseOptions(options)
}

function flyToml(options: FlyOptions): string {
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

function dockerfile(options: FlyOptions): string {
  return [
    "FROM node:22-slim",
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
  emit(context: DeploymentAdapterContext) {
    const options = optionsOf(context.options)
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
