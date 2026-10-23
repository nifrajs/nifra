import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { defineMcpWidget, UI_MIME } from "../src/index.ts"
import { bundleReactWidget, reactWidget } from "../src/react.ts"

describe("reactWidget", () => {
  test("bundles a React component into a self-contained ui:// widget", async () => {
    const widget = await reactWidget({
      uri: "ui://test/hello",
      name: "Hello",
      component: join(import.meta.dir, "fixtures/Hello.tsx"),
    })
    expect(widget.uri).toBe("ui://test/hello")
    expect(widget.meta.ui).toEqual({ resourceUri: "ui://test/hello" })

    const { text, mimeType } = await widget.resource.read()
    expect(mimeType).toBe(UI_MIME)
    // Mount point + the bridge are present...
    expect(text).toContain('<div id="root">')
    expect(text).toContain("window.mcpApp")
    // ...and the bundled React runtime is inlined (react + react-dom is large).
    expect(text.length).toBeGreaterThan(50_000)
    // The closing </body> survives - i.e. the bundle's own `</script` didn't terminate the inline script.
    expect(text.trimEnd().endsWith("</html>")).toBe(true)
  }, 20_000)

  test("minify:false still produces a valid widget", async () => {
    const widget = await reactWidget({
      uri: "ui://test/hello2",
      name: "Hello",
      component: join(import.meta.dir, "fixtures/Hello.tsx"),
      minify: false,
    })
    const { text } = await widget.resource.read()
    expect(text).toContain('<div id="root">')
    expect(text.trimEnd().endsWith("</html>")).toBe(true)
  }, 20_000)

  test("bundleReactWidget returns a body that defineMcpWidget serves without bundling again", async () => {
    const body = await bundleReactWidget({ component: join(import.meta.dir, "fixtures/Hello.tsx") })
    expect(body.startsWith('<div id="root"></div>\n<script>')).toBe(true)
    expect(body.endsWith("</script>")).toBe(true)
    // Only the closing tag survives unescaped: the bundle's own `</script` spellings are escaped.
    expect(body.match(/<\/script/gi)?.length).toBe(1)

    const widget = defineMcpWidget({ uri: "ui://test/prebuilt", name: "Hello", html: body })
    const { text, mimeType } = await widget.resource.read()
    expect(mimeType).toBe(UI_MIME)
    expect(text).toContain(body)
    expect(text).toContain("window.mcpApp")
    expect(text.trimEnd().endsWith("</html>")).toBe(true)
  }, 20_000)
})
