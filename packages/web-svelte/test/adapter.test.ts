import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

test("svelteAdapter conforms under the real SSR plugin", async () => {
  const code = `
    import { plugin } from "bun";
    import { assertRenderAdapterConformance } from ${asImport("../../web/src/conformance.ts")};
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));

    const { svelteAdapter } = await import(${asImport("../src/index.ts")});
    const ConformancePage = (await import(${asImport("./fixtures/conformance-page.svelte")})).default;
    const Outer = (await import(${asImport("./fixtures/conformance-outer.svelte")})).default;
    const Inner = (await import(${asImport("./fixtures/conformance-inner.svelte")})).default;

    await assertRenderAdapterConformance(svelteAdapter, {
      page: ConformancePage,
      outerLayout: Outer,
      innerLayout: Inner,
      props: { data: { name: "conformance-data" }, pending: true },
      markers: {
        page: 'data-page="leaf"',
        data: "conformance-data",
        pending: 'data-pending="true"',
        outer: 'data-layout="outer"',
        inner: 'data-layout="inner"',
      },
    });

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
