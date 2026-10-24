/** The Workers runtime module the platform-env fixture route imports; only its `env` is used. */
declare module "cloudflare:workers" {
  export const env: Readonly<Record<string, unknown>>
}
