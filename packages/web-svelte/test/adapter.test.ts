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

  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, codeResult] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(`${stdout}${stderr}`).toBe("")
  expect(codeResult).toBe(0)
})

test("the adapter can be imported BEFORE the SSR plugin is registered", async () => {
  // The order every dev server actually produces. `loadApp` imports the app's config, which re-exports
  // this adapter, and only then can the CLI register the app's `serverPlugins` - so by the time a
  // compiler exists, this module has already evaluated. A static `import Chain from "./Chain.svelte"`
  // therefore loaded a path string, and SSR died with `component is not a function` naming the asset
  // rather than the ordering. `Chain` is loaded on first render instead, which is after registration.
  const code = `
    const { svelteAdapter } = await import(${asImport("../src/index.ts")});

    const { plugin } = await import("bun");
    const { svelteBunPlugin } = await import(${asImport("../src/plugin.ts")});
    plugin(svelteBunPlugin("ssr"));

    const SearchPage = (await import(${asImport("./fixtures/search-page.svelte")})).default;
    const html = await svelteAdapter.renderToString([SearchPage], {
      data: null, search: { page: 2 }, path: "/r?page=2",
    });
    if (!/data-search[^>]*>2</.test(html)) throw new Error("late plugin registration lost: " + html);
  `
  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
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

    const html = await svelteAdapter.renderToString([SearchPage], {
      data: null, search: { page: 2 }, path: "/r?page=2",
    });
    if (!/data-search[^>]*>2</.test(html)) throw new Error("useSearch did not read search; got: " + html);
  `
  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, codeResult] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(`${stdout}${stderr}`).toBe("")
  expect(codeResult).toBe(0)
})
