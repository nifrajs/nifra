import { expect, test } from "bun:test"
import {
  certifyAdapter,
  runtimeAdapterCertificationProfile,
} from "../../testing/src/certification.ts"
import { handle, type LambdaEvent } from "../src/index.ts"

test("the AWS Lambda adapter satisfies the portable runtime certification profile", async () => {
  const report = await certifyAdapter({
    profile: runtimeAdapterCertificationProfile(),
    adapterId: "aws-lambda-v2",
    createAdapter: () => ({
      async start(app) {
        const invoke = handle(app)
        const running = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            const body =
              request.method === "GET" || request.method === "HEAD"
                ? undefined
                : await request.text()
            const event: LambdaEvent = {
              rawPath: url.pathname,
              rawQueryString: url.search.slice(1),
              headers: Object.fromEntries(request.headers),
              ...(body === undefined ? {} : { body }),
              requestContext: {
                domainName: url.hostname,
                http: { method: request.method, sourceIp: "127.0.0.1" },
              },
            }
            const result = await invoke(event, { awsRequestId: "nifra-certification" })
            const response = new Response(
              result.isBase64Encoded
                ? Uint8Array.from(atob(result.body), (character) => character.charCodeAt(0))
                : result.body,
              { status: result.statusCode, headers: result.headers },
            )
            for (const cookie of result.cookies ?? []) response.headers.append("set-cookie", cookie)
            return response
          },
        })
        return {
          origin: `http://127.0.0.1:${running.port}`,
          stop: () => running.stop(true),
        }
      },
    }),
  })
  expect(report.ok).toBe(true)
  expect(report.capabilities.map((capability) => capability.capability)).toEqual([
    "request-bridge",
    "response-bridge",
    "lifecycle",
  ])
})
