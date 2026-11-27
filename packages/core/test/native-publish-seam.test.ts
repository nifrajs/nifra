import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { server } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

const INSTALL_NATIVE_PUBLISH = Symbol.for("@nifrajs/core/install-native-publish")

type Installer = (
  publish: (topic: string, data: string | ArrayBufferView | ArrayBuffer) => void,
  remove?: boolean,
) => boolean

function installerOf(app: object): Installer | undefined {
  const fn = Reflect.get(app, INSTALL_NATIVE_PUBLISH)
  if (typeof fn !== "function") return undefined
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `INSTALL_NATIVE_PUBLISH` attached by `websocket()` has the `(publish, remove?) => boolean` contract.
  return fn as Installer
}

describe("INSTALL_NATIVE_PUBLISH multi-listener seam (@nifrajs/core/ws)", () => {
  test("declines apps without ws routes and supports multi-listener fan-out + removal", () => {
    const empty = server().use(websocket())
    const installEmpty = installerOf(empty)
    expect(installEmpty).toBeDefined()
    expect(installEmpty?.(() => {})).toBe(false)

    const app = server()
      .use(websocket())
      .ws("/chat", { message() {} })
    const install = installerOf(app)
    expect(install).toBeDefined()

    const seenA: Array<readonly [string, string | ArrayBufferView | ArrayBuffer]> = []
    const seenB: Array<readonly [string, string | ArrayBufferView | ArrayBuffer]> = []
    const seenC: Array<readonly [string, string | ArrayBufferView | ArrayBuffer]> = []
    const pubA = (topic: string, data: string | ArrayBufferView | ArrayBuffer): void => {
      seenA.push([topic, data])
    }
    const pubB = (topic: string, data: string | ArrayBufferView | ArrayBuffer): void => {
      seenB.push([topic, data])
    }
    const pubC = (topic: string, data: string | ArrayBufferView | ArrayBuffer): void => {
      seenC.push([topic, data])
    }

    expect(install?.(pubA)).toBe(true)
    expect(install?.(pubB)).toBe(true)
    expect(install?.(pubC)).toBe(true)

    app.publish("room", "one")
    expect(seenA).toEqual([["room", "one"]])
    expect(seenB).toEqual([["room", "one"]])
    expect(seenC).toEqual([["room", "one"]])

    // Remove first publisher -> two stay active via remove-branch composite loop
    expect(install?.(pubA, true)).toBe(false)
    app.publish("room", "two")
    expect(seenA).toEqual([["room", "one"]])
    expect(seenB).toEqual([
      ["room", "one"],
      ["room", "two"],
    ])
    expect(seenC).toEqual([
      ["room", "one"],
      ["room", "two"],
    ])

    // Remove second publisher -> one stays active
    expect(install?.(pubB, true)).toBe(false)
    app.publish("room", "three")
    expect(seenB).toHaveLength(2)
    expect(seenC).toHaveLength(3)

    // Remove third publisher -> no native publisher remains, pub/sub falls back safely
    expect(install?.(pubC, true)).toBe(false)
    app.publish("room", "four")
    expect(seenC).toHaveLength(3)

    // Removing again is a safe no-op
    expect(install?.(pubC, true)).toBe(false)
  })

  test("declines native pub/sub when validateSend is enabled", () => {
    const validated = server()
      .use(websocket())
      .ws("/v", {
        sendSchema: t.object({ ok: t.boolean() }),
        validateSend: true,
        message() {},
      })
    expect(installerOf(validated)?.(() => {})).toBe(false)
  })
})
