import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

const run = async (code: string): Promise<void> => {
  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(`${stdout}${stderr}`).toBe("")
  expect(exit).toBe(0)
}

// Both renders go through the SSR compiler: the server adapter, and `Router.svelte` (what the client
// mount hydrates). They must report the same chain, or every breadcrumb layout mismatches on hydration.
const setup = `
  import { plugin } from "bun";
  import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
  plugin(svelteBunPlugin("ssr"));

  const { render } = await import(${JSON.stringify(import.meta.resolve("svelte/server"))});
  const { svelteAdapter } = await import(${asImport("../src/index.ts")});
  const Router = (await import(${asImport("../src/Router.svelte")})).default;
  const Report = (await import(${asImport("./fixtures/matches-report.svelte")})).default;

  const matchChain = { ids: ["_layout", "orgs/[org]"], handles: ["Home", { crumb: "Org" }] };
  const expected = JSON.stringify([
    ["_layout", "/", "Home", { user: "ada" }],
    ["orgs/[org]", "/orgs/acme", { crumb: "Org" }, { org: "acme" }],
  ]);
  const decode = (html) => html.replaceAll("&quot;", '"');
  const expectReports = (html, where, value) => {
    if (!decode(html).includes('data-at="' + where + '">' + value)) {
      throw new Error("no " + where + " report of " + value + " in " + html);
    }
  };
`

test("useMatches reports the whole chain to a layout and to the page", async () => {
  await run(`${setup}
    const html = await svelteAdapter.renderToString([Report, Report], {
      data: { org: "acme" }, layoutData: [{ user: "ada" }], params: { org: "acme" }, path: "/orgs/acme",
      matchChain,
    });
    expectReports(html, "layout", expected);
    expectReports(html, "page", expected);
  `)
})

test("the mounted router reports what the server rendered", async () => {
  await run(`${setup}
    const state = {
      routeId: "orgs/[org]", params: { org: "acme" }, path: "/orgs/acme", data: { org: "acme" },
      layoutData: [{ user: "ada" }], pending: false,
    };
    const router = { snapshot: () => state, subscribe: () => () => {} };
    const html = render(Router, {
      props: {
        router, routes: { "orgs/[org]": [Report, Report] }, searchSchemas: undefined,
        matchChains: { "orgs/[org]": matchChain },
      },
    }).body;
    expectReports(html, "layout", expected);
    expectReports(html, "page", expected);
  `)
})

test("a render without a chain reports nothing", async () => {
  await run(`${setup}
    expectReports(await svelteAdapter.renderToString([Report], { data: null, path: "/" }), "page", "[]");
  `)
})
