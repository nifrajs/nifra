import assert from "node:assert/strict"
import { chromium, firefox, webkit } from "playwright"

const engines = process.env.NIFRA_COMPONENT_BROWSER
  ? {
      [process.env.NIFRA_COMPONENT_BROWSER]: { chromium, firefox, webkit }[
        process.env.NIFRA_COMPONENT_BROWSER
      ],
    }
  : { chromium, firefox, webkit }
for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      // Chromium reports the deliberately denied owner GET as a resource error.
      if (
        message.location().url?.includes("deny=yes") &&
        /^Failed to load resource: the server responded with a status of 403(?: \([^)]*\))?$/.test(
          message.text(),
        )
      )
        return
      // Under the strict CSP and Trusted Types runs, React's development Flight client tries eval to
      // rebuild server stacks: it says so once, and the browser reports the blocked attempt. Production
      // React never evals, so neither is a fixture failure.
      if (
        /react-server-dom[^/]*client/.test(message.location().url ?? "") &&
        /\beval\b|TrustedScript/.test(message.text())
      )
        return
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText
      // The race and invalidation cases deliberately abort in-flight reads.
      // WebKit on Linux reports those aborts as "Load request cancelled".
      if (
        reason !== "net::ERR_ABORTED" &&
        reason !== "NS_BINDING_ABORTED" &&
        reason !== "cancelled" &&
        reason !== "Load request cancelled"
      )
        errors.push(`${request.url()} ${reason}`)
    })
    await page.addInitScript(() => {
      window.lifecycle = { mounted: 0, disposed: 0 }
      window.addEventListener("fixture:mounted", () => window.lifecycle.mounted++)
      window.addEventListener("fixture:disposed", () => window.lifecycle.disposed++)
    })
    await page.goto(process.env.NIFRA_COMPONENT_URL ?? "http://127.0.0.1:4422/")
    try {
      await page.waitForFunction(() => window.fixture?.ready, undefined, { timeout: 15000 })
    } catch (error) {
      console.error({ engine: name, errors })
      throw error
    }
    await page.locator("#counter").click()
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    await page.locator("#child-counter").click()
    await page.locator("#child-value").fill("kept child input")
    await page.evaluate(() => {
      window.keptChild = document.querySelector("#child-value")
    })
    await page.locator("#parent-counter").click()
    assert.equal(await page.locator("#parent-counter").textContent(), "Parent 1")
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    await page.locator("#value").fill("kept input")
    await page.evaluate(() => {
      window.kept = document.querySelector("#value")
      window.kept.setSelectionRange(1, 5)
      window.kept.focus()
    })
    assert.equal(await page.evaluate(() => window.fixture.refresh("?revision=new")), true)
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    assert.equal(await page.locator("#value").inputValue(), "kept input")
    assert.equal(await page.locator("#revision").textContent(), "Revision 2")
    assert.equal(await page.locator("#parent-counter").textContent(), "Parent 1")
    assert.equal(
      await page.locator("nifra-slot").filter({ hasText: "Slot 2" }).textContent(),
      "Slot 2",
    )
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector("#value") === window.kept &&
          document.activeElement === window.kept &&
          window.kept.selectionStart === 1 &&
          window.kept.selectionEnd === 5,
      ),
      true,
    )
    assert.equal(await page.locator("#child-counter").textContent(), "Count 1")
    assert.equal(await page.locator("#child-revision").textContent(), "Child 2")
    assert.equal(await page.locator("#child-value").inputValue(), "kept child input")
    assert.equal(
      await page.evaluate(() => document.querySelector("#child-value") === window.keptChild),
      true,
    )
    assert.equal(await page.evaluate(() => window.fixture.refreshChild("?revision=latest")), true)
    assert.equal(await page.locator("#child-revision").textContent(), "Child 3")
    assert.equal(await page.locator("#revision").textContent(), "Revision 2")
    assert.equal(await page.locator("#portal").textContent(), "Portal Public title 2")
    assert.equal(await page.locator("#child-portal").textContent(), "Portal Child 3")
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 2, disposed: 0 })
    await page.locator("#nav-next").click()
    // Revision 2 is already rendered by refresh; wait for the navigation's destination as well.
    await page.waitForFunction(
      () =>
        !window.fixture.router.snapshot().pending &&
        window.fixture.router.snapshot().path === "/?revision=new" &&
        document.querySelector("#revision")?.textContent === "Revision 2",
    )
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    assert.equal(await page.locator("#child-counter").textContent(), "Count 1")
    await page.locator("#nav-latest").click()
    await page.waitForFunction(
      () =>
        !window.fixture.router.snapshot().pending &&
        window.fixture.router.snapshot().path === "/?revision=latest" &&
        document.querySelector("#revision")?.textContent === "Revision 3",
    )
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    assert.equal(await page.locator("#child-counter").textContent(), "Count 1")
    await page.goBack()
    await page.waitForFunction(
      () =>
        !window.fixture.router.snapshot().pending &&
        window.fixture.router.snapshot().path === "/?revision=new" &&
        document.querySelector("#revision")?.textContent === "Revision 2",
    )
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    assert.equal(await page.locator("#child-counter").textContent(), "Count 1")
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 2, disposed: 0 })
    await page.evaluate(() => window.fixture.router.navigate("/"))
    await page.waitForFunction(
      () => document.querySelector("#revision")?.textContent === "Revision 1",
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.mutate(true)), { ok: false })
    assert.equal(await page.locator("#revision").textContent(), "Revision 1")
    assert.deepEqual(await page.evaluate(() => window.fixture.mutate()), { ok: true })
    assert.equal(await page.locator("#revision").textContent(), "Revision 2")
    await page.evaluate(() => window.fixture.submit())
    try {
      await page.waitForFunction(
        () => document.querySelector("#revision")?.textContent === "Revision 3",
        undefined,
        { timeout: 10000 },
      )
    } catch (error) {
      console.error({
        engine: name,
        revision: await page.locator("#revision").textContent(),
        snapshot: await page.evaluate(() => ({
          pending: window.fixture.router.snapshot().pending,
          actionData: window.fixture.router.snapshot().actionData,
          data: window.fixture.router.snapshot().data,
        })),
        errors,
      })
      throw error
    }
    assert.equal(await page.evaluate(() => window.fixture.router.snapshot().actionData.saved), true)
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    const race = await page.evaluate(async () => {
      const old = window.fixture.refresh("?revision=new&delay=slow")
      const next = window.fixture.refresh("?revision=latest")
      return Promise.all([old, next])
    })
    assert.deepEqual(race, [false, true])
    assert.equal(await page.locator("#revision").textContent(), "Revision 3")
    assert.equal(await page.locator("#counter").textContent(), "Count 1")
    assert.equal(
      await page.evaluate(() => window.fixture.refresh("?revision=latest&rekey=yes")),
      true,
    )
    assert.equal(await page.locator("#counter").textContent(), "Count 0")
    assert.equal(await page.locator("#child-counter").textContent(), "Count 1")
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 3, disposed: 1 })
    assert.equal(
      await page.evaluate(() => window.fixture.refresh("?revision=latest&remove=yes&rekey=yes")),
      true,
    )
    assert.equal(await page.locator("#child-counter").count(), 0)
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 3, disposed: 2 })
    assert.equal(
      await page.evaluate(() => window.fixture.refresh("?revision=latest&rekey=yes")),
      true,
    )
    assert.equal(await page.locator("#child-counter").textContent(), "Count 0")
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 4, disposed: 2 })
    await page.evaluate(async () => {
      const pending = window.fixture.refresh("?revision=new&delay=slow")
      await window.fixture.invalidate()
      await pending
    })
    assert.equal(await page.locator("#counter").count(), 0)
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 4, disposed: 4 })
    await page.evaluate(() => window.fixture.switchScope())
    await page.waitForFunction(
      () => document.querySelector("#revision")?.textContent === "Revision 3",
    )
    assert.equal(await page.locator("#counter").textContent(), "Count 0")
    assert.equal(await page.locator("#child-counter").textContent(), "Count 0")
    assert.equal(await page.locator("#portal").textContent(), "Portal B title 3")
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 6, disposed: 4 })
    assert.equal(await page.evaluate(() => window.fixture.refresh("?deny=yes")), false)
    assert.equal(await page.locator("#counter").count(), 0)
    assert.deepEqual(await page.evaluate(() => window.lifecycle), { mounted: 6, disposed: 6 })
    assert.deepEqual(errors, [])
    for (const interruption of ["auth", "navigation"]) {
      await page.goto(process.env.NIFRA_COMPONENT_URL ?? "http://127.0.0.1:4422/")
      await page.waitForFunction(() => window.fixture?.ready)
      const result = await page.evaluate(async (interruption) => {
        const adapter = window.componentTestAdapter
        const prepare = adapter.prepare.bind(adapter)
        let release, entered
        const gate = new Promise((accept) => {
          release = accept
        })
        const starting = new Promise((accept) => {
          entered = accept
        })
        adapter.prepare = async (...args) => {
          entered()
          await gate
          return prepare(...args)
        }
        const pending = window.fixture.refresh("?revision=new")
        await starting
        adapter.prepare = prepare
        if (interruption === "auth") await window.fixture.invalidate()
        else await window.fixture.router.navigate("/?revision=latest")
        release()
        return pending
      }, interruption)
      assert.equal(result, false, "Obsolete native preparation must not commit")
      if (interruption === "auth") assert.equal(await page.locator("#counter").count(), 0)
      else
        await page.waitForFunction(
          () => document.querySelector("#revision")?.textContent === "Revision 3",
        )
      await page.evaluate(() => window.fixture.dispose())
    }
    const progressive = await browser.newPage({ javaScriptEnabled: false })
    await progressive.goto(process.env.NIFRA_COMPONENT_URL ?? "http://127.0.0.1:4422/")
    assert.equal(await progressive.locator("#revision").textContent(), "Revision 1")
    await Promise.all([
      progressive.waitForURL((url) => url.search === "?revision=new"),
      progressive.locator("#nav-next").click(),
    ])
    assert.equal(await progressive.locator("#revision").textContent(), "Revision 2")
    await Promise.all([
      progressive.waitForURL((url) => url.search === ""),
      progressive.locator("#progressive-save").click(),
    ])
    assert.equal(await progressive.locator("#revision").textContent(), "Revision 3")
    await progressive.close()
    console.log(
      JSON.stringify({
        engine: name,
        version: browser.version(),
        adapter: process.env.NIFRA_COMPONENT_ADAPTER ?? "vue",
        cases: [
          "hydrate",
          "native-props",
          "state",
          "dom",
          "focus",
          "selection",
          "managed-slot",
          "owned-portal",
          "nested-subtree",
          "router-history",
          "serverFn-success-failure",
          "action-revalidation",
          "child-only-refresh",
          "table-svg",
          "remove-readd",
          "rekey",
          "stale-fetch",
          "auth-invalidation",
          "scope-remount",
          "denied-refresh",
          "auth-during-native-prepare",
          "navigation-during-native-prepare",
          "progressive-form",
          "dispose",
        ],
        status: "passed",
      }),
    )
  } finally {
    await browser.close()
  }
}
