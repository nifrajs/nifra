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

test(
  "in a browser, a refill updates an interactive root's props and keeps its state, drops an older one, and shows the error slot",
  async () => {
    const served = await inBun(`
      const { render } = await import("svelte/server");
      const { svelteAdapter } = await import(${asImport("../src/index.ts")});
      const { ui } = await import(${asImport("../src/ppr.ts")});
      const Page = (await import(${asImport("./fixtures/ppr-refill-page.svelte")})).default;
      const Tally = (await import(${asImport("./fixtures/ppr-tally.svelte")})).default;
      const of = (interactive) => ({ name: "cart", interactive, render: (data) => ui(Tally, { count: data.count }) });
      const shell = (interactive) =>
        render(Page, { props: { of: of(interactive), initial: { status: "pending", ppr: true } } }).body;
      const frame = (count) => svelteAdapter.renderFragment(() => ui(Tally, { count }), { idPrefix: "nifra-cart-" });
      console.log(JSON.stringify({ shell: shell(true), inertShell: shell(false), two: await frame(2), three: await frame(3) }));
    `)
    const visit = async (interactive: boolean): Promise<unknown> => {
      const script = `
        const { GlobalWindow } = await import("happy-dom");
        const window = new GlobalWindow({ url: "http://shop.test/" });
        for (const key of Object.getOwnPropertyNames(window)) {
          if (!(key in globalThis)) globalThis[key] = window[key];
        }
        const { plugin } = await import("bun");
        const { svelteBunPlugin } = await import(${asImport("../src/plugin.ts")});
        plugin(svelteBunPlugin("dom"));
        const { flushSync, hydrate, unmount } = await import("svelte");
        const { ui } = await import(${asImport("../src/ppr.ts")});
        const Page = (await import(${asImport("./fixtures/ppr-refill-page.svelte")})).default;
        const Tally = (await import(${asImport("./fixtures/ppr-tally.svelte")})).default;
        const served = ${JSON.stringify(served)};
        globalThis.__nifraPpr = Object.assign(() => {}, {
          get: (name) => (name === "cart" ? { props: { count: 2 }, error: false } : undefined),
          subscribe: () => () => {},
          put(name, frame, host) {
            host.innerHTML = frame.html;
            if (frame.error) host.setAttribute("data-nifra-hole-error", "");
            else host.removeAttribute("data-nifra-hole-error");
          },
        });
        const tick = async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          flushSync();
        };
        const deferred = () => {
          let resolve, reject;
          const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
          promise.catch(() => {});
          return { fill: { __nifra_deferred: true, id: 0, promise }, resolve, reject };
        };
        const of = { name: "cart", interactive: ${interactive}, render: (data) => ui(Tally, { count: data.count }) };
        const container = document.createElement("div");
        container.innerHTML = ${interactive} ? served.shell : served.inertShell;
        document.body.append(container);
        const host = container.querySelector('[data-nifra-hole="cart"]');
        host.innerHTML = served.two;
        const page = hydrate(Page, { target: container, props: { of, initial: { status: "pending", ppr: true } } });
        flushSync();
        const seen = [];
        host.querySelector("button").click();
        flushSync();
        seen.push(host.textContent);
        const first = deferred();
        page.reload({ status: "pending", ppr: true, fill: first.fill });
        flushSync();
        seen.push(host.textContent, host.getAttribute("aria-busy"));
        first.resolve({ html: "<p>cart 7</p>", props: { count: 7 } });
        await tick();
        seen.push(host.textContent);
        const older = deferred();
        const newer = deferred();
        page.reload({ status: "pending", ppr: true, fill: older.fill });
        flushSync();
        page.reload({ status: "pending", ppr: true, fill: newer.fill });
        flushSync();
        newer.resolve({ html: "<p>cart 9</p>", props: { count: 9 } });
        await tick();
        older.resolve({ html: "<p>cart 8</p>", props: { count: 8 } });
        await tick();
        seen.push(host.textContent);
        const failed = deferred();
        page.reload({ status: "pending", ppr: true, fill: failed.fill });
        flushSync();
        failed.reject(new Error("deferred_error"));
        await tick();
        seen.push(host.textContent, host.hasAttribute("data-nifra-hole-error"));
        page.reload({ status: "pending", ppr: true, fill: { html: served.three, props: { count: 3 } } });
        await tick();
        host.querySelector("button")?.click();
        flushSync();
        seen.push(host.textContent);
        unmount(page);
        console.log(JSON.stringify(seen));
      `
      const proc = Bun.spawn([process.execPath, "--conditions=browser", "--eval", script], {
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
    expect(await visit(true)).toEqual([
      "cart 2 clicked 1",
      "cart 2 clicked 1",
      "true",
      "cart 7 clicked 1",
      "cart 9 clicked 1",
      "This section is unavailable.",
      true,
      "cart 3 clicked 1",
    ])
    // A server-only host only ever shows the server's HTML: a click changes nothing.
    expect(await visit(false)).toEqual([
      "cart 2 clicked 0",
      "cart 2 clicked 0",
      "true",
      "cart 7",
      "cart 9",
      "This section is unavailable.",
      true,
      "cart 3 clicked 0",
    ])
  },
  SPAWN_TIMEOUT_MS,
)
