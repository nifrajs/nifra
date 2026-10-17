import { expect, test } from "bun:test"
import { parseProxyOha } from "./oha.ts"

test("raw Bun POST forwarding reuses upstream connections", async () => {
  const origin = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
      import { createServer } from 'node:http';
      let connections = 0;
      const server = createServer((req, res) => {
        if (req.url === '/stats') { res.end(JSON.stringify({ connections })); return; }
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"id":"1","name":"Ada"}');
        });
      });
      server.on('connection', () => connections++);
      server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const originErrors = new Response(origin.stderr).text()
  let proxy: ReturnType<typeof Bun.spawn> | undefined
  let proxyErrors: Promise<string> | undefined
  try {
    const reader = origin.stdout.getReader()
    const first = await reader.read()
    reader.releaseLock()
    const originPort = Number(new TextDecoder().decode(first.value).trim())
    if (!Number.isInteger(originPort) || originPort <= 0) throw new Error("origin did not bind")
    const reserved = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
    const port = reserved.port
    reserved.stop(true)
    if (port === undefined) throw new Error("could not reserve a proxy port")
    const startedProxy = Bun.spawn(
      ["bun", `${import.meta.dir}/serve-bun.ts`, "bun-raw", String(port), String(originPort)],
      { stdout: "ignore", stderr: "pipe" },
    )
    proxy = startedProxy
    proxyErrors = new Response(startedProxy.stderr).text()
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`${base}/users/1`, { signal: AbortSignal.timeout(100) })
        await response.arrayBuffer()
        if (response.status === 200) {
          ready = true
          break
        }
      } catch {
        // The proxy process has not bound its port yet.
      }
      await Bun.sleep(20)
    }
    if (!ready) throw new Error("raw proxy did not become ready")
    const load = Bun.spawn(
      [
        "oha",
        "-n",
        "5000",
        "-c",
        "50",
        "--no-tui",
        "--output-format",
        "json",
        "-m",
        "POST",
        "-H",
        "content-type: application/json",
        "-d",
        '{"name":"Ada","age":36}',
        `${base}/users`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [raw, errors, code] = await Promise.all([
      new Response(load.stdout).text(),
      new Response(load.stderr).text(),
      load.exited,
    ])
    expect(code, errors).toBe(0)
    expect(parseProxyOha(raw).rps).toBeGreaterThan(0)
    const stats: unknown = await fetch(`http://127.0.0.1:${originPort}/stats`).then((r) => r.json())
    if (
      typeof stats !== "object" ||
      stats === null ||
      !("connections" in stats) ||
      typeof stats.connections !== "number"
    )
      throw new Error("invalid connection stats")
    // A pooled 50-client workload needs tens of sockets, not thousands of one-off connections.
    expect(stats.connections).toBeLessThan(256)
  } finally {
    if (proxy !== undefined) {
      proxy.kill()
      await proxy.exited
    }
    origin.kill()
    await origin.exited
    await proxyErrors
    await originErrors
  }
}, 15_000)
