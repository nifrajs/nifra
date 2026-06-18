import { describe, expect, test } from "bun:test"
import { createScheduler } from "../src/index.ts"

const at = (h: number, mi: number) => new Date(2026, 5, 13, h, mi)

describe("createScheduler", () => {
  test("tick fires a due job once per matching minute", () => {
    let runs = 0
    const cron = createScheduler().add("m", "*/5 * * * *", () => {
      runs++
    })
    cron.tick(at(10, 5))
    cron.tick(at(10, 5)) // same minute → not fired again
    expect(runs).toBe(1)
    cron.tick(at(10, 6)) // not a match
    expect(runs).toBe(1)
    cron.tick(at(10, 10)) // next match
    expect(runs).toBe(2)
  })

  test("only due jobs fire", () => {
    const log: string[] = []
    const cron = createScheduler()
      .add("hourly", "0 * * * *", () => {
        log.push("hourly")
      })
      .add("minutely", "* * * * *", () => {
        log.push("minutely")
      })
    cron.tick(at(9, 0))
    expect(log.sort()).toEqual(["hourly", "minutely"])
    log.length = 0
    cron.tick(at(9, 1))
    expect(log).toEqual(["minutely"])
  })

  test("a throwing job is isolated (onError), never stops the loop", () => {
    const errors: string[] = []
    let goodRuns = 0
    const cron = createScheduler({ onError: (_e, name) => errors.push(name) })
      .add("bad", "* * * * *", () => {
        throw new Error("boom")
      })
      .add("good", "* * * * *", () => {
        goodRuns++
      })
    cron.tick(at(1, 0))
    expect(errors).toEqual(["bad"])
    expect(goodRuns).toBe(1) // good still ran despite bad throwing
  })

  test("overlap guard: a still-running async job is skipped next minute, not stacked", async () => {
    let starts = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const cron = createScheduler().add("slow", "* * * * *", async () => {
      starts++
      await gate // stays "running" until released
    })
    cron.tick(at(1, 0))
    cron.tick(at(1, 1)) // previous still running → skipped
    expect(starts).toBe(1)
    release()
    await gate
    await Promise.resolve() // let the .then(running=false) settle
    cron.tick(at(1, 2)) // now free → runs again
    expect(starts).toBe(2)
  })

  test("an async rejection routes to onError and clears running", async () => {
    const errors: unknown[] = []
    const cron = createScheduler({ onError: (e) => errors.push(e) }).add("r", "* * * * *", () =>
      Promise.reject(new Error("async boom")),
    )
    cron.tick(at(1, 0))
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })

  test("runNow fires off-schedule", () => {
    let runs = 0
    const cron = createScheduler().add("j", "0 0 1 1 *", () => {
      runs++
    })
    cron.runNow("j")
    expect(runs).toBe(1)
    cron.runNow("nope") // unknown → no-op, no throw
    expect(runs).toBe(1)
  })

  test("duplicate name + bad expression throw at add (not at fire)", () => {
    const cron = createScheduler().add("a", "* * * * *", () => {})
    expect(() => cron.add("a", "* * * * *", () => {})).toThrow(/already registered/)
    expect(() => cron.add("b", "bad expr here now", () => {})).toThrow(/invalid cron/)
  })

  test("jobNames lists registered jobs in order", () => {
    const cron = createScheduler()
      .add("first", "* * * * *", () => {})
      .add("second", "* * * * *", () => {})
    expect(cron.jobNames).toEqual(["first", "second"])
  })

  test("start/stop wire a real interval without throwing", () => {
    const cron = createScheduler().add("j", "* * * * *", () => {})
    cron.start(10_000)
    cron.start(10_000) // idempotent
    cron.stop()
    cron.stop() // safe to call twice
    expect(cron.jobNames).toEqual(["j"])
  })
})

describe("createScheduler defaults", () => {
  test("default clock: tick() with no arg uses the real now", () => {
    let ran = false
    const cron = createScheduler().add("always", "* * * * *", () => {
      ran = true
    })
    cron.tick() // no date → default now() (every-minute expr always matches the current minute)
    expect(ran).toBe(true)
  })

  test("default onError swallows a throw via console.error (loop survives)", () => {
    const original = console.error
    const captured: unknown[] = []
    console.error = (...args: unknown[]) => {
      captured.push(args)
    }
    try {
      const cron = createScheduler().add("boom", "* * * * *", () => {
        throw new Error("default-onerror")
      })
      expect(() => cron.runNow("boom")).not.toThrow()
      expect(captured.length).toBe(1)
    } finally {
      console.error = original
    }
  })
})
