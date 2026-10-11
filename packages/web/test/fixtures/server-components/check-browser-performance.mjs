import assert from "node:assert/strict"
import { chromium, firefox, webkit } from "playwright"

const percentile = (values, ratio) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1]
for (const [engine, launcher] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await launcher.launch()
  try {
    const page = await browser.newPage()
    await page.goto(process.env.NIFRA_COMPONENT_URL)
    await page.waitForFunction(() => window.fixture?.ready)
    const coldPrepareMs = await page.evaluate(() => window.componentTimings.firstPrepareMs)
    const runs = []
    for (let run = 0; run < 5; run++) {
      const evidence = await page.evaluate(async () => {
        for (let index = 0; index < 30; index++)
          if (!(await window.fixture.refresh(index % 2 ? "?revision=new" : "?revision=latest")))
            throw new Error("warmup failed")
        window.componentTimings.prepare.length = 0
        window.componentTimings.commit.length = 0
        for (let index = 0; index < 200; index++)
          if (!(await window.fixture.refresh(index % 2 ? "?revision=new" : "?revision=latest")))
            throw new Error("refresh failed")
        return { prepare: window.componentTimings.prepare, commit: window.componentTimings.commit }
      })
      assert.ok(evidence.prepare.length >= 200 && evidence.commit.length >= 200)
      runs.push({
        prepareP95: percentile(evidence.prepare, 0.95),
        commitP95: percentile(evidence.commit, 0.95),
      })
    }
    const prepareP95 = percentile(
      runs.map((run) => run.prepareP95),
      0.5,
    )
    const commitP95 = percentile(
      runs.map((run) => run.commitP95),
      0.5,
    )
    assert.ok(
      prepareP95 + commitP95 <= 50,
      `${engine} native prepare/commit exceeds the 50ms budget`,
    )
    await page.evaluate(() => window.fixture.dispose())
    console.log(
      JSON.stringify({
        adapter: process.env.NIFRA_COMPONENT_ADAPTER,
        engine,
        version: browser.version(),
        suite: "native-prepare-commit-performance",
        status: "passed",
        coldPrepareMs,
        prepareP95,
        commitP95,
        runs,
        samples: 200,
        warmups: 30,
      }),
    )
  } finally {
    await browser.close()
  }
}
