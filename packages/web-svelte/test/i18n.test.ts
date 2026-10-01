import { expect, test } from "bun:test"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)

// Rendered in a child process: the Svelte compiler plugin is registered process-wide.
test("I18nProvider passes fallback, onMissing and numberingSystem to the formatter", async () => {
  const code = `
    import { plugin } from "bun";
    import { svelteBunPlugin } from ${asImport("../src/plugin.ts")};
    plugin(svelteBunPlugin("ssr"));
    const { render } = await import(${JSON.stringify(import.meta.resolve("svelte/server"))});
    const App = (await import(${asImport("./fixtures/i18n-app.svelte")})).default;
    const missing = [];
    const { body } = render(App, { props: { onMissing: (key) => missing.push(key) } });
    process.stdout.write(JSON.stringify({ body, missing }));
  `
  const proc = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  const { body, missing } = JSON.parse(stdout) as { body: string; missing: string[] }
  expect(body).toContain("अपना|Hi Ada - १२ messages|gone")
  expect(missing).toEqual(["gone"])
})
