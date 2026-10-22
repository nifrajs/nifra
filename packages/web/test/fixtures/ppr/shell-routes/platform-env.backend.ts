import { env } from "cloudflare:workers"

// Reads the Worker's bindings and secrets with no request: refused by the shell check.
export const shellLoader = async () => ({ region: String(env.REGION) })
