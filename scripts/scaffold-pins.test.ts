import { expect, test } from "bun:test"
import { unsatisfiablePins } from "./scaffold-pins.ts"

const versions = new Map([
  ["@nifrajs/core", "5.0.0-rc.1"],
  ["@nifrajs/web", "5.0.0"],
])

test("a pin a fresh install cannot resolve is reported", () => {
  expect(
    unsatisfiablePins(
      {
        dependencies: { "@nifrajs/core": "^5.0.0", "@nifrajs/gone": "^5.0.0", react: "^19.0.0" },
        devDependencies: { "@nifrajs/web": "workspace:*" },
      },
      versions,
    ),
  ).toEqual([
    '@nifrajs/core="^5.0.0" does NOT satisfy the current 5.0.0-rc.1 (caret excludes the prerelease?)',
    '@nifrajs/gone="^5.0.0" → no such monorepo package',
    '@nifrajs/web="workspace:*" → workspace: protocol in a template (unresolvable for an external app)',
  ])
})

test("control: pins the current versions satisfy pass", () => {
  expect(
    unsatisfiablePins(
      { dependencies: { "@nifrajs/core": "^5.0.0-rc.1", "@nifrajs/web": "^5.0.0" } },
      versions,
    ),
  ).toEqual([])
})
