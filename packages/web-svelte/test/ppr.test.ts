import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)
// Each test starts a fresh Bun that compiles Svelte from cold; on a busy Windows runner that took 4-5s.
const SPAWN_TIMEOUT_MS = 30_000

/** Runs `code` in a fresh Bun with the SSR plugin registered and returns what it printed as JSON. */
async function inBun(code: string): Promise<unknown> {
  const script = `
    const { plugin } = await import("bun");
    const { svelteBunPlugin } = await import(${asImport("../src/plugin.ts")});
    plugin(svelteBunPlugin("ssr"));
    ${code}
  `
  // From the package, so the script's bare `svelte/*` imports resolve whatever the runner's cwd.
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  return JSON.parse(stdout)
}

test(
  "a hole's fragment renders from ui(Component, props) with ids under its own prefix",
  async () => {
    const out = await inBun(`
      const { svelteAdapter } = await import(${asImport("../src/index.ts")});
      const { ui } = await import(${asImport("../src/ppr.ts")});
      const Field = (await import(${asImport("./fixtures/ppr-id.svelte")})).default;
      const html = await svelteAdapter.renderFragment(() => ui(Field, { label: "qty" }), { idPrefix: "nifra-cart-" });
      let refused = "";
      try {
        await svelteAdapter.renderFragment(() => "<p>not ui</p>", {});
      } catch (error) {
        refused = error.message;
      }
      console.log(JSON.stringify({ html, refused }));
    `)
    expect(out).toEqual({
      html: '<!--[--><!--$nifra-cart-s1--><label for="nifra-cart-s1">qty</label><input id="nifra-cart-s1"/><!--]-->',
      refused: "[nifra/web-svelte] a hole's render and fallback must return ui(Component, props)",
    })
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "Hole renders an empty host for a shell, and the boundary's own states otherwise",
  async () => {
    const out = await inBun(`
      const { render } = await import("svelte/server");
      const { ui } = await import(${asImport("../src/ppr.ts")});
      const Hole = (await import(${asImport("../src/Hole.svelte")})).default;
      const Field = (await import(${asImport("./fixtures/ppr-id.svelte")})).default;
      const of = {
        name: "cart",
        render: (data) => ui(Field, { label: "ready " + data.n }),
        fallback: ui(Field, { label: "waiting" }),
      };
      const body = (state) => render(Hole, { props: { of, state } }).body.replace(/<!--[^>]*-->/g, "");
      console.log(JSON.stringify({
        shell: body({ status: "pending", ppr: true }),
        unrendered: body(undefined),
        ready: body({ status: "ready", data: { n: 1 } }),
        failed: body({ status: "error" }),
        streamedEmpty: body({ status: "pending" }),
        streamedValue: body({ status: "pending", data: { n: 2 } }),
      }));
    `)
    expect(out).toEqual({
      shell: '<div data-nifra-hole="cart" aria-busy="true"></div>',
      unrendered: '<label for="s1">waiting</label><input id="s1"/>',
      ready: '<label for="s1">ready 1</label><input id="s1"/>',
      failed: "",
      streamedEmpty: '<label for="s1">waiting</label><input id="s1"/>',
      streamedValue: '<label for="s1">ready 2</label><input id="s1"/>',
    })
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "the Svelte PPR app serves a checked shell that links its holes' scoped CSS, and fills them after it",
  async () => {
    const out = await inBun(`
      const { startPprApp } = await import(${asImport("./fixtures/ppr-app/server.ts")});
      const app = await startPprApp();
      try {
        const response = await fetch(app.origin + "/p/1", { headers: { cookie: "name=ada" } });
        const html = await response.text();
        const at = (text) => html.indexOf(text);
        const scope = /svelte-[a-z0-9]+/.exec(html.slice(at('id="nifra-ppr:cart"')))?.[0];
        const sheet = /<link rel="stylesheet" href="([^"]+)">/.exec(html.slice(0, at("</head>")))?.[1];
        const css = sheet === undefined ? "" : await (await fetch(app.origin + sheet)).text();
        console.log(JSON.stringify({
          failed: app.shellFailures.map(([route]) => route),
          status: response.status,
          fallbackInShell: at('<p id="cart-fallback">loading cart</p>') !== -1,
          framesAfterShell: at('id="nifra-ppr:greeting"') > at("</main>"),
          greeting: html.includes("hello ada"),
          cartProps: html.includes('"props":{"count":2}'),
          holeCss: scope !== undefined && css.includes("button." + scope + "{font-weight:700}"),
          warnings: app.warnings,
        }));
      } finally {
        await app.stop();
      }
    `)
    expect(out).toEqual({
      failed: ["leaky/[id]"],
      status: 200,
      fallbackInShell: true,
      framesAfterShell: true,
      greeting: true,
      cartProps: true,
      holeCss: true,
      warnings: [],
    })
  },
  SPAWN_TIMEOUT_MS,
)
