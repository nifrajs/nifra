import { expect, test } from "bun:test"
import { unlink } from "node:fs/promises"

const SPAWN_TIMEOUT_MS = 30_000

test(
  "Solid binding loads and renders a client route slot",
  async () => {
    const childTestPath = new URL(
      `./route-slot-client-child-${crypto.randomUUID()}.test.ts`,
      import.meta.url,
    ).pathname
    const code = `
      import { afterAll, expect, mock, test } from "bun:test";
      import { GlobalWindow } from ${JSON.stringify(import.meta.resolve("happy-dom"))};

      const browser = new GlobalWindow({ url: "https://route-slot.test/dashboard" });
      const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
      const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
      const installedGlobals = [];
      for (const key of Object.getOwnPropertyNames(browser)) {
        if (key in globalThis) continue;
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: Reflect.get(browser, key),
        });
        installedGlobals.push(key);
      }
      globalThis.window = browser;
      globalThis.document = browser.document;
      const solid = await import(${JSON.stringify(import.meta.resolve("solid-js").replace(/server\.(?:c?js)$/, "solid.js"))});
      const web = await import(${JSON.stringify(import.meta.resolve("solid-js/web").replace(/server\.(?:c?js)$/, "web.js"))});
      mock.module("solid-js", () => solid);
      mock.module("solid-js/web", () => web);
      const routeSlot = await import(${JSON.stringify(new URL("../src/route-slot.tsx", import.meta.url).href)});
      const router = await import(${JSON.stringify(new URL("../src/router.ts", import.meta.url).href)});
      const { installRouteSlotClientHarness } = await import(${JSON.stringify(new URL("../../web/test/route-slot-client-harness.ts", import.meta.url).href)});

      afterAll(async () => {
        mock.restore();
        for (const key of installedGlobals) Reflect.deleteProperty(globalThis, key);
        if (beforeWindow === undefined) Reflect.deleteProperty(globalThis, "window");
        else Object.defineProperty(globalThis, "window", beforeWindow);
        if (beforeDocument === undefined) Reflect.deleteProperty(globalThis, "document");
        else Object.defineProperty(globalThis, "document", beforeDocument);
        await browser.happyDOM.close();
      });

      test("client adapter follows the shared route-slot store", async () => {
        const Target = (props) => solid.createComponent(web.Dynamic, {
          component: "p",
          id: "slot-ready",
          get children() { return props.data.label; },
        });
        const harness = installRouteSlotClientHarness([Target]);
        const container = document.createElement("div");
        document.body.append(container);
        const path = "/dashboard?tab=solid&slot.inspector=%2Fusers%2F7";

        function Probe() {
          const slot = routeSlot.useRouteSlot("inspector");
          const panel = solid.createComponent(routeSlot.RouteSlot, {
            name: "inspector",
            fallback: solid.createComponent(web.Dynamic, {
              component: "p",
              children: "Loading target",
            }),
          });
          const status = solid.createComponent(web.Dynamic, {
            component: "output",
            id: "slot-status",
            get children() { return slot.status(); },
          });
          return [panel, status];
        }

        const dispose = web.render(() => solid.createComponent(router.RenderPropsContext.Provider, {
          value: { data: null, path, pending: false },
          get children() { return solid.createComponent(Probe, {}); },
        }), container);
        try {
          for (let attempt = 0; attempt < 50 && !container.querySelector("#slot-ready"); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 0));
          expect(container.querySelector("#slot-ready")?.textContent).toBe("authorized target");
          expect(container.querySelector("#slot-status")?.textContent).toBe("ready");
          expect(harness.requests).toHaveLength(1);
        } finally {
          dispose();
          container.remove();
          harness.restore();
        }
      });
    `
    await Bun.write(childTestPath, code)
    try {
      const proc = Bun.spawn([process.execPath, "test", childTestPath], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, codeResult] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(`${stdout}${stderr}`).toContain("route-slot store")
      if (codeResult !== 0) throw new Error(`${stdout}${stderr}`)
      expect(codeResult).toBe(0)
    } finally {
      await unlink(childTestPath).catch(() => {})
    }
  },
  SPAWN_TIMEOUT_MS,
)
