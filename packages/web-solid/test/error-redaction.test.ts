import { expect, test } from "bun:test"
import type { RenderProps } from "@nifrajs/web"
import { createComponent, ErrorBoundary } from "solid-js"
import { solidAdapter } from "../src/index.ts"

const SECRET = "password authentication failed for user admin@10.0.3.7"
const Page = () =>
  createComponent(ErrorBoundary, {
    fallback: () => "Something went wrong",
    get children(): unknown {
      throw new Error(SECRET)
    },
  })
const props = { data: {}, params: {} } as unknown as RenderProps

async function underNodeEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV
  if (value === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
}

const rendered = {
  string: async () =>
    String(await solidAdapter.renderToString?.([Page], props, { nonce: "N0NCE" })),
  stream: async () =>
    new Response(await solidAdapter.renderToStream([Page], props, { nonce: "N0NCE" })).text(),
}

for (const [lane, render] of Object.entries(rendered)) {
  test(`outside development, a caught server error reaches hydration without its text (${lane})`, async () => {
    for (const env of ["production", undefined]) {
      const html = await underNodeEnv(env, render)
      expect(html).toContain("Something went wrong")
      expect(html).toContain('new Error("Internal Server Error")')
      expect(html).not.toContain("password authentication")
      expect(html).not.toMatch(/sourceURL|stack:/)
      expect(html).toMatch(/<script nonce="N0NCE">[^<]*\$R/)
    }
  })

  test(`in development the caught error keeps its message (${lane})`, async () => {
    expect(await underNodeEnv("development", render)).toContain(SECRET)
  })
}
