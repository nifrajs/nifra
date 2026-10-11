import assert from "node:assert/strict"
import { chromium } from "playwright"

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.lifecycle = { mounted: 0, disposed: 0 }
    window.addEventListener("fixture:mounted", () => window.lifecycle.mounted++)
    window.addEventListener("fixture:disposed", () => window.lifecycle.disposed++)
  })
  await page.goto(process.env.NIFRA_COMPONENT_URL)
  await page.waitForFunction(() => window.fixture?.ready)
  const session = await page.context().newCDPSession(page)
  const measure = async () => {
    await session.send("HeapProfiler.collectGarbage")
    return (await session.send("Runtime.getHeapUsage")).usedSize
  }
  const cycle = async (index) => {
    assert.equal(
      await page.evaluate(
        (index) =>
          window.fixture.refresh(index % 2 === 0 ? "?revision=new&rekey=yes" : "?revision=latest"),
        index,
      ),
      true,
    )
    if (index % 10 === 0) {
      await page.evaluate(() => window.fixture.router.navigate("/?revision=latest"))
      await page.waitForFunction(
        () => document.querySelector("#revision")?.textContent === "Revision 3",
      )
    }
  }
  for (let index = 0; index < 25; index++) await cycle(index)
  const before = await measure()
  for (let index = 0; index < 1000; index++) await cycle(index)
  const after = await measure()
  const budget = Math.max(before * 0.05, 2 * 1024 * 1024)
  assert.ok(after - before <= budget, `Retained heap growth ${after - before} exceeds ${budget}`)
  await page.evaluate(() => window.fixture.dispose())
  assert.equal(await page.locator("#counter").count(), 0)
  const lifecycle = await page.evaluate(() => window.lifecycle)
  assert.equal(lifecycle.mounted, lifecycle.disposed)
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      adapter: process.env.NIFRA_COMPONENT_ADAPTER,
      engine: "chromium",
      cycles: 1000,
      warmup: 25,
      before,
      after,
      growth: after - before,
      budget,
      lifecycle,
      status: "passed",
    }),
  )
} finally {
  await browser.close()
}
