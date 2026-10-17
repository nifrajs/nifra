import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CERTIFIED_COMPONENT_REACT,
  CERTIFIED_COMPONENT_VITE,
} from "../src/internal/certified-components.ts"
import { serverComponentsPlugin } from "../src/server-components/vite.ts"

const root = resolve(import.meta.dir, "../../..")
/** The workspaces in this repository that run the server-component pipeline. */
const PIPELINE = ["packages/web", "packages/web-react", "examples"]
const REACT_PACKAGES = ["react", "react-dom", "react-server-dom-webpack"]

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

function declared(dir: string, section: string, name: string): unknown {
  return Reflect.get(
    Object(Reflect.get(Object(json(resolve(root, dir, "package.json"))), section)),
    name,
  )
}

function installed(dir: string, name: string): unknown {
  const require = createRequire(resolve(root, dir, "package.json"))
  return Reflect.get(Object(json(require.resolve(`${name}/package.json`))), "version")
}

describe("the server-component pipeline's certified versions", () => {
  test("every manifest that runs the pipeline pins them exactly", () => {
    for (const dir of PIPELINE) {
      const vite = declared(dir, "devDependencies", "vite") ?? declared(dir, "dependencies", "vite")
      expect({ dir, vite }).toEqual({ dir, vite: CERTIFIED_COMPONENT_VITE })
    }
    for (const section of ["peerDependencies", "devDependencies"])
      expect(declared("packages/web-react", section, "react-server-dom-webpack")).toBe(
        CERTIFIED_COMPONENT_REACT,
      )
    for (const section of ["overrides", "devDependencies"])
      for (const name of ["react", "react-dom"])
        expect({ section, name, version: declared(".", section, name) }).toEqual({
          section,
          name,
          version: CERTIFIED_COMPONENT_REACT,
        })
  })

  test("the copies those workspaces load are the certified ones", () => {
    for (const dir of PIPELINE)
      expect({ dir, vite: installed(dir, "vite") }).toEqual({ dir, vite: CERTIFIED_COMPONENT_VITE })
    for (const name of REACT_PACKAGES)
      expect({ name, version: installed("packages/web-react", name) }).toEqual({
        name,
        version: CERTIFIED_COMPONENT_REACT,
      })
  })

  test("the React guard names every version it found when the trio drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "nifra-component-react-"))
    try {
      await writeFile(join(root, "package.json"), "{}")
      const found = {
        react: CERTIFIED_COMPONENT_REACT,
        "react-dom": "0.0.1",
        "react-server-dom-webpack": CERTIFIED_COMPONENT_REACT,
      }
      for (const [name, version] of Object.entries(found)) {
        await mkdir(join(root, "node_modules", name), { recursive: true })
        await writeFile(
          join(root, "node_modules", name, "package.json"),
          JSON.stringify({ name, version }),
        )
      }
      const { configResolved } = serverComponentsPlugin({ root, adapter: "react" })
      if (typeof configResolved !== "function") throw new Error("missing configResolved")
      expect(() => Reflect.apply(configResolved, {}, [{ root }])).toThrow(
        `not react@${CERTIFIED_COMPONENT_REACT}, react-dom@0.0.1, react-server-dom-webpack@${CERTIFIED_COMPONENT_REACT}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
