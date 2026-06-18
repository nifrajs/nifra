import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

test("svelteAdapter renders sync and stream output under the real SSR plugin", async () => {
  const code = `
    import { plugin } from "bun";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));

    const { svelteAdapter } = await import(${asImport("../src/index.ts")});
    const Page = (await import(${asImport("./fixtures/page.svelte")})).default;
    const Layout = (await import(${asImport("./fixtures/layout.svelte")})).default;

    const renderToString = svelteAdapter.renderToString;
    if (renderToString === undefined) throw new Error("missing renderToString");
    const sync = await renderToString([Layout, Page], {
      data: { greeting: "hello from sync svelte" },
    });
    if (!sync.includes("hello from sync svelte")) throw new Error(sync);
    if (!sync.includes("data-layout=\\"outer\\"")) throw new Error(sync);

    const stream = await new Response(
      svelteAdapter.renderToStream([Page], {
        data: { greeting: "hello from stream svelte" },
      }),
    ).text();
    if (!stream.includes("hello from stream svelte")) throw new Error(stream);
    if (svelteAdapter.hydrationHead() !== "") throw new Error("unexpected hydration head");
  `

  const proc = Bun.spawn(["bun", "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, codeResult] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(`${stdout}${stderr}`).toBe("")
  expect(codeResult).toBe(0)
})
