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

test("useSearch reads the route's search from Chain's context (SSR-correct)", async () => {
  // The server puts the validated search in RenderProps.search; Chain.svelte provides it via context and
  // the page's `useSearch()` reads it. The client mount derives the same value, so hydration matches.
  const code = `
    import { plugin } from "bun";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));

    const { svelteAdapter } = await import(${asImport("../src/index.ts")});
    const SearchPage = (await import(${asImport("./fixtures/search-page.svelte")})).default;

    const html = svelteAdapter.renderToString([SearchPage], {
      data: null, search: { page: 2 }, path: "/r?page=2",
    });
    if (!/data-search[^>]*>2</.test(html)) throw new Error("useSearch did not read search; got: " + html);
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
