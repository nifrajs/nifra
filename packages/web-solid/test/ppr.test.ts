import { expect, test } from "bun:test"
import { createComponent, createUniqueId } from "solid-js"
import { renderToString } from "solid-js/web"
import { solidAdapter } from "../src/index.ts"
import { Hole, type HoleDefinition, type HoleProps } from "../src/ppr.ts"
import { element, visible } from "./ssr-output.ts"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)
// Each spawn compiles the fixture's routes with Solid's Babel transform from cold.
const SPAWN_TIMEOUT_MS = 30_000

/**
 * Runs `code` in a fresh Bun with Solid's plugin for `generate` registered and returns what it printed
 * as JSON. The plugin compiles every `.tsx` the process loads, so this suite's own process must not
 * register it; `dom` also resolves Solid's browser build, which `bun test` never loads.
 */
async function inBun(generate: "dom" | "ssr", code: string): Promise<unknown> {
  const script = `
    const { plugin } = await import("bun");
    const { solidBunPlugin } = await import(${asImport("../src/plugin.ts")});
    plugin(solidBunPlugin(${JSON.stringify(generate)}));
    ${code}
  `
  const conditions = generate === "dom" ? ["--conditions=browser"] : []
  const proc = Bun.spawn([process.execPath, ...conditions, "--eval", script], {
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

function Field(props: { readonly name: string }) {
  return element("input", { id: createUniqueId(), name: props.name })
}

test("a hole's fragment renders inside renderFragment, keyed under the hole's prefix; a fallback is unkeyed", () => {
  const renderFragment = solidAdapter.renderFragment?.bind(solidAdapter)
  let rendering = false
  const html = renderFragment?.(
    () => {
      rendering = true
      return createComponent(Field, { name: "qty" })
    },
    { idPrefix: "nifra-cart-" },
  )
  expect(rendering).toBe(true)
  expect(html).toBe('<input data-hk="nifra-cart-01" id="nifra-cart-00" name="qty"/>')
  // A fallback is a function, resolved after the render's own call returns.
  expect(renderFragment?.(() => () => createComponent(Field, { name: "wait" }), {})).toBe(
    '<input id="0" name="wait"/>',
  )
})

test("Hole renders an empty host for a shell, and the boundary's own states otherwise", () => {
  const of: HoleDefinition<{ readonly n: number }> = {
    name: "cart",
    render: (data) => element("p", {}, `ready ${data.n}`),
    fallback: () => element("p", {}, "waiting"),
  }
  const body = (state: HoleProps<{ readonly n: number }>["state"]) =>
    visible(
      renderToString(() =>
        createComponent(Hole<{ readonly n: number }>, {
          of,
          state,
          error: element("p", {}, "failed"),
        }),
      ),
    )
  expect({
    shell: body({ status: "pending", ppr: true }),
    blocking: body({ status: "pending", ppr: true, fill: { v: 1, html: "<p>held</p>" } }),
    unrendered: body(undefined),
    ready: body({ status: "ready", data: { n: 1 } }),
    failed: body({ status: "error" }),
    streamedEmpty: body({ status: "pending" }),
    streamedValue: body({ status: "pending", data: { n: 2 } }),
    streamedPending: body({
      status: "pending",
      data: { __nifra_deferred: true, promise: new Promise(() => {}) },
    }),
  }).toEqual({
    shell: '<div data-nifra-hole="cart" aria-busy="true"></div>',
    blocking: '<div data-nifra-hole="cart" aria-busy="true"><p>held</p></div>',
    unrendered: "<p>waiting</p>",
    ready: "<p>ready 1</p>",
    failed: "<p>failed</p>",
    streamedEmpty: "<p>waiting</p>",
    streamedValue: "<p>ready 2</p>",
    streamedPending: "<p>waiting</p>",
  })
})

test(
  "the Solid PPR app serves a checked shell and fills its holes after it",
  async () => {
    const out = await inBun(
      "ssr",
      `
      const { startPprApp } = await import(${asImport("./fixtures/ppr-app/server.ts")});
      const app = await startPprApp();
      try {
        const response = await fetch(app.origin + "/p/1", { headers: { cookie: "name=ada" } });
        const html = await response.text();
        const at = (text) => html.indexOf(text);
        const frame = (name) => {
          const start = html.indexOf(">", at('id="nifra-ppr:' + name + '"')) + 1;
          return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
        };
        console.log(JSON.stringify({
          failed: app.shellFailures.map(([route]) => route),
          status: response.status,
          fallbackInShell: at('<p id="cart-fallback">loading cart</p>') !== -1,
          framesAfterShell: at('id="nifra-ppr:greeting"') > at("</main>"),
          // Solid marks the inserted name, so the text arrives split by comments.
          greeting: frame("greeting").html.replace(/<!--[^>]*-->/g, "").includes("hello ada"),
          cartProps: html.includes('"props":{"count":2}'),
          warnings: app.warnings,
        }));
      } finally {
        await app.stop();
      }
    `,
    )
    expect(out).toEqual({
      failed: ["leaky/[id]"],
      status: 200,
      fallbackInShell: true,
      framesAfterShell: true,
      greeting: true,
      cartProps: true,
      warnings: [],
    })
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "in a browser, an interactive hole hydrates as its own root in either fill order and is disposed on leave",
  async () => {
    const page = asImport("./fixtures/ppr-app/routes/p/[id].tsx")
    const shell = JSON.stringify({
      data: { title: "Product 1" },
      boundaries: {
        greeting: { status: "pending", ppr: true },
        cart: { status: "pending", ppr: true },
        slow: { status: "pending", ppr: true },
      },
    })
    // The shell page and the cart's frame HTML, as the server renders them.
    const served = await inBun(
      "ssr",
      `
      const { createComponent } = await import("solid-js");
      const { renderToString } = await import("solid-js/web");
      const { solidAdapter } = await import(${asImport("../src/index.ts")});
      const page = await import(${page});
      const cart = page.boundaries.find((hole) => hole.name === "cart");
      console.log(JSON.stringify({
        page: renderToString(() => createComponent(page.default, ${shell})),
        cart: solidAdapter.renderFragment(() => cart.render({ count: 2 }), { idPrefix: "nifra-cart-" }),
      }));
    `,
    )
    // One document per child: Solid keeps hydration state at module level for the page's lifetime.
    const visit = (filledFirst: boolean) =>
      inBun(
        "dom",
        `
      const { GlobalWindow } = await import("happy-dom");
      const window = new GlobalWindow({ url: "http://shop.test/" });
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!(key in globalThis)) globalThis[key] = window[key];
      }
      globalThis._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
      const { createComponent } = await import("solid-js");
      const { hydrate } = await import("solid-js/web");
      const page = await import(${page});
      const served = ${JSON.stringify(served)};
      const fill = { props: { count: 2 }, error: false };
      const waiting = new Map();
      const unsubscribed = [];
      globalThis.__nifraPpr = Object.assign(() => {}, {
        get: (name) => (${filledFirst} && name === "cart" ? fill : undefined),
        subscribe(name, callback) {
          waiting.set(name, callback);
          return () => {
            waiting.delete(name);
            unsubscribed.push(name);
          };
        },
        put(name, frame, host) {
          host.innerHTML = frame.html;
        },
      });
      const container = document.createElement("div");
      container.innerHTML = served.page;
      document.body.append(container);
      const host = container.querySelector('[data-nifra-hole="cart"]');
      if (${filledFirst}) host.innerHTML = served.cart;
      const dispose = hydrate(() => createComponent(page.default, ${shell}), container);
      if (!${filledFirst}) {
        host.innerHTML = served.cart;
        waiting.get("cart")(fill);
      }
      await new Promise((resolve) => queueMicrotask(resolve));
      const button = host.querySelector("button");
      button.click();
      const clicked = host.textContent;
      const kept = host.querySelector("button") === button;
      dispose();
      console.log(JSON.stringify({ clicked, kept, unsubscribed, emptied: host.childNodes.length === 0 }));
    `,
      )
    const out = { first: await visit(true), later: await visit(false) }
    expect(out).toEqual({
      first: { clicked: "cart 3", kept: true, unsubscribed: [], emptied: true },
      later: { clicked: "cart 3", kept: true, unsubscribed: ["cart"], emptied: true },
    })
  },
  SPAWN_TIMEOUT_MS,
)

test(
  "in a browser, a refill updates an interactive root through its store and keeps its state, drops an older one, and shows the error slot",
  async () => {
    const page = asImport("./fixtures/ppr-refill.tsx")
    const served = await inBun(
      "ssr",
      `
      const { createComponent } = await import("solid-js");
      const { renderToString } = await import("solid-js/web");
      const { solidAdapter } = await import(${asImport("../src/index.ts")});
      const page = await import(${page});
      const shell = (interactive) =>
        renderToString(() => createComponent(page.Page, { interactive, state: { status: "pending", ppr: true } }));
      const frame = (count) =>
        solidAdapter.renderFragment(() => page.tally.render({ count }), { idPrefix: "nifra-cart-" });
      console.log(JSON.stringify({ shell: shell(true), inertShell: shell(false), two: frame(2), three: frame(3) }));
    `,
    )
    const visit = (interactive: boolean) =>
      inBun(
        "dom",
        `
      const { GlobalWindow } = await import("happy-dom");
      const window = new GlobalWindow({ url: "http://shop.test/" });
      for (const key of Object.getOwnPropertyNames(window)) {
        if (!(key in globalThis)) globalThis[key] = window[key];
      }
      globalThis._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
      const { createComponent, createSignal } = await import("solid-js");
      const { hydrate } = await import("solid-js/web");
      const page = await import(${page});
      const served = ${JSON.stringify(served)};
      const fills = { cart: { props: { count: 2 }, error: false } };
      globalThis.__nifraPpr = Object.assign(() => {}, {
        get: (name) => fills[name],
        subscribe: () => () => {},
        put(name, frame, host) {
          host.innerHTML = frame.html;
          if (frame.error) host.setAttribute("data-nifra-hole-error", "");
          else host.removeAttribute("data-nifra-hole-error");
        },
      });
      const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
      const deferred = () => {
        let resolve, reject;
        const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
        promise.catch(() => {});
        return { fill: { __nifra_deferred: true, id: 0, promise }, resolve, reject };
      };
      const container = document.createElement("div");
      container.innerHTML = ${interactive} ? served.shell : served.inertShell;
      document.body.append(container);
      const host = container.querySelector('[data-nifra-hole="cart"]');
      host.innerHTML = served.two;
      const [state, setState] = createSignal({ status: "pending", ppr: true });
      const dispose = hydrate(
        () => createComponent(page.Page, { interactive: ${interactive}, get state() { return state(); } }),
        container,
      );
      await tick();
      const seen = [];
      host.querySelector("button").click();
      seen.push(host.textContent);
      const first = deferred();
      setState({ status: "pending", ppr: true, fill: first.fill });
      seen.push(host.textContent, host.getAttribute("aria-busy"));
      first.resolve({ html: "<p>cart 7</p>", props: { count: 7 } });
      await tick();
      seen.push(host.textContent);
      const older = deferred();
      const newer = deferred();
      setState({ status: "pending", ppr: true, fill: older.fill });
      setState({ status: "pending", ppr: true, fill: newer.fill });
      newer.resolve({ html: "<p>cart 9</p>", props: { count: 9 } });
      await tick();
      older.resolve({ html: "<p>cart 8</p>", props: { count: 8 } });
      await tick();
      seen.push(host.textContent);
      const failed = deferred();
      setState({ status: "pending", ppr: true, fill: failed.fill });
      failed.reject(new Error("deferred_error"));
      await tick();
      seen.push(host.textContent, host.hasAttribute("data-nifra-hole-error"));
      setState({ status: "pending", ppr: true, fill: { html: served.three, props: { count: 3 } } });
      await tick();
      host.querySelector("button")?.click();
      seen.push(host.textContent);
      dispose();
      console.log(JSON.stringify(seen));
    `,
      )
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
