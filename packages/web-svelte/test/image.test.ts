import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

test("Image renders imported dimensions and real prebuilt variants", async () => {
  const code = `
    import { plugin } from "bun";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));
    const { render } = await import(${JSON.stringify(import.meta.resolve("svelte/server"))});
    const Image = (await import(${asImport("../src/Image.svelte")})).default;
    const src = { src: "/assets/full.png", width: 800, height: 400,
      variants: [{ src: "/assets/small.webp", width: 200, height: 100 }, { src: "/assets/large.webp", width: 400, height: 200 }] };
    process.stdout.write(render(Image, { props: { src, width: 200, alt: "imported" } }).body);
  `
  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [html, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  expect(html).toContain('width="200"')
  expect(html).toContain('height="100"')
  expect(html).toContain('src="/assets/small.webp"')
  expect(html).toContain("/assets/small.webp 200w, /assets/large.webp 400w")
  expect(html).not.toContain("[object Object]")
})
