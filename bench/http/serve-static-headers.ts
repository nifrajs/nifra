/**
 * Bun server for the static-response-header A/B (see _static-headers-app.ts).
 *
 *   bun run bench/http/serve-static-headers.ts <static|hook> <port>
 */
import { makeStaticHeadersApp, variantOf } from "./_static-headers-app.ts"

const variant = variantOf(process.argv[2])
const port = Number(process.argv[3])
if (!Number.isInteger(port)) {
  throw new Error("usage: bun run bench/http/serve-static-headers.ts <static|hook> <port>")
}

makeStaticHeadersApp(variant).listen(port)
