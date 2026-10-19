import { expect, test } from "bun:test"
import { HTTP_WORKLOADS, httpGetTrail, MULTIPLIERS } from "../site/shared/data/benchmarks.ts"

const rps = (value: string): number => Number(value.replaceAll(",", ""))

test("the headline multipliers run largest first", () => {
  const values = MULTIPLIERS.map((item) => Number.parseFloat(item.mult))
  expect(values.length).toBeGreaterThan(1)
  expect(values).toEqual([...values].sort((a, b) => b - a))
})

test("a runtime's bare-GET gap is read from the published rows", () => {
  for (const table of HTTP_WORKLOADS) {
    const nifra = table.rows.find((row) => row.nifra)
    if (nifra === undefined) continue
    const fastest = Math.max(...table.rows.map((row) => rps(row.getUsers)))
    const trail = httpGetTrail(table.title)
    if (rps(nifra.getUsers) >= fastest) {
      expect(trail).toBeUndefined()
      continue
    }
    expect(trail?.nifra).toBe(nifra)
    expect(rps(trail?.rival.getUsers ?? "0")).toBe(fastest)
    expect(trail?.behindPercent).toBeCloseTo((1 - rps(nifra.getUsers) / fastest) * 100, 10)
  }
})

test("a runtime with no published table has no gap", () => {
  expect(httpGetTrail("Lunar")).toBeUndefined()
})
