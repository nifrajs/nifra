import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

test("the mounted Router renders each layout with the snapshot's layout data", async () => {
  // `Router.svelte` is what the client mount hydrates. The server rendered these layouts with their
  // data, so a client render that drops it is a mismatch on the first paint. Rendered through the
  // SSR compiler here: the props the component derives are the same ones the client build derives.
  const code = `
    import { plugin } from "bun";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));

    const { render } = await import(${JSON.stringify(import.meta.resolve("svelte/server"))});
    const Router = (await import(${asImport("../src/Router.svelte")})).default;
    const Layout = (await import(${asImport("./fixtures/data-layout.svelte")})).default;
    const Page = (await import(${asImport("./fixtures/conformance-page.svelte")})).default;

    const bodyFor = (layoutData) => {
      const state = {
        routeId: "org/index", params: {}, path: "/org", data: { name: "leaf-data" }, pending: false,
        ...(layoutData === undefined ? {} : { layoutData }),
      };
      const router = { snapshot: () => state, subscribe: () => () => {} };
      return render(Router, {
        props: { router, routes: { "org/index": [Layout, Layout, Page] }, searchSchemas: undefined },
      }).body;
    };

    const withData = bodyFor([{ from: "root" }, { from: "org" }]);
    for (const marker of ['data-from="root"', 'data-from="org"', "leaf-data"]) {
      if (!withData.includes(marker)) throw new Error("missing " + marker + ": " + withData);
    }
    const without = bodyFor(undefined);
    if (without.split('data-from="none"').length !== 3) throw new Error("expected two empty layouts: " + without);
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
