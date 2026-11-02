import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)
// Each test starts a fresh Bun that compiles Svelte from cold; on a busy Windows runner that took 4-5s.
const SPAWN_TIMEOUT_MS = 30_000

test(
  "svelteAdapter conforms under the real SSR plugin",
  async () => {
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
  },
  SPAWN_TIMEOUT_MS,
)
test(
  "RouteSlot renders its fallback during SSR while the URL-addressed target loads",
  async () => {
    const code = `
      import { plugin } from "bun";
      import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
      plugin(svelteBunPlugin("ssr"));
      const { svelteAdapter } = await import(${asImport("../src/index.ts")});
      const RouteSlotPage = (await import(${asImport("./fixtures/route-slot-page.svelte")})).default;
      const path = "/dashboard?slot.inspector=%2Fusers%2F7";
      const html = await svelteAdapter.renderToString([RouteSlotPage], {
        data: null, search: {}, path,
      });
      if (!html.includes("<p>Select a user.</p>")) throw new Error("RouteSlot did not render its SSR fallback; got: " + html);
    `
    const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, codeResult] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${stdout}${stderr}`).toBe("")
    expect(codeResult).toBe(0)
  },
  SPAWN_TIMEOUT_MS,
)
test(
  "RouteSlot loads and renders an authorized target in the browser runtime",
  async () => {
    const code = `
      import { plugin } from "bun";
      import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
      plugin(svelteBunPlugin("dom"));
      const { GlobalWindow } = await import(${JSON.stringify(import.meta.resolve("happy-dom"))});
      const browser = new GlobalWindow({ url: "https://route-slot.test/dashboard" });
      for (const key of Object.getOwnPropertyNames(browser)) {
        if (key in globalThis) continue;
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: Reflect.get(browser, key),
        });
      }
      globalThis.window = browser;
      globalThis.document = browser.document;
      const { mock } = await import("bun:test");
      const svelteClient = await import(${JSON.stringify(import.meta.resolve("svelte").replace("index-server.js", "index-client.js"))});
      mock.module("svelte", () => svelteClient);
      const { flushSync, mount, unmount } = svelteClient;
      const { installRouteSlotClientHarness } = await import(${asImport("../../web/test/route-slot-client-harness.ts")});
      const Target = (await import(${asImport("./fixtures/route-slot-client-target.svelte")})).default;
      const Page = (await import(${asImport("./fixtures/route-slot-client-page.svelte")})).default;
      const harness = installRouteSlotClientHarness([Target]);
      const container = document.createElement("div");
      document.body.append(container);
      const render = async (path) => {
        const component = mount(Page, { target: container, props: { path } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        flushSync();
        return component;
      };
      const ready = await render("/dashboard?slot.inspector=%2Fusers%2F7");
      if (container.querySelector("#slot-ready")?.textContent !== "authorized target")
        throw new Error("RouteSlot did not render the authorized client target: " + container.innerHTML);
      if (harness.requests.length !== 1) throw new Error("RouteSlot did not use one authorized route-data request");
      unmount(ready);
      container.replaceChildren();
      const invalid = await render("/dashboard?slot.inspector=not-a-path");
      if (!container.querySelector('[data-route-slot-error="invalid_target"]'))
        throw new Error("RouteSlot did not render its invalid-target state: " + container.innerHTML);
      unmount(invalid);
      harness.restore();
      await browser.happyDOM.close();
    `
    const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, codeResult] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${stdout}${stderr}`).toBe("")
    expect(codeResult).toBe(0)
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "the adapter can be imported BEFORE the SSR plugin is registered",
  async () => {
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
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "useSearch reads the route's search from Chain's context (SSR-correct)",
  async () => {
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
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "<svelte:head> content reaches the document's <head>, buffered and streamed",
  async () => {
    const code = `
    import { plugin } from "bun";
    import { defer, renderPageResult } from ${asImport("../../web/src/index.ts")};
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));

    const { svelteAdapter } = await import(${asImport("../src/index.ts")});
    const HeadPage = (await import(${asImport("./fixtures/head-page.svelte")})).default;
    for (const data of [{ n: 1 }, { slow: defer(Promise.resolve(1)) }]) {
      const page = await renderPageResult({
        adapter: svelteAdapter, chain: [HeadPage], data, clientEntry: "/c.js", routeId: "index", title: "t",
      });
      const html = await page.toResponse().text();
      const head = html.slice(0, html.indexOf("</head>"));
      if (!head.includes('<meta name="robots" content="noindex"')) throw new Error("head lost: " + html);
      if (!head.includes('href="https://example.test/head"')) throw new Error("head lost: " + html);
      if (!html.includes('data-page="head"')) throw new Error("body lost: " + html);
    }
  `
    const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, codeResult] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${stdout}${stderr}`).toBe("")
    expect(codeResult).toBe(0)
  },
  SPAWN_TIMEOUT_MS,
)
