import { describe, expect, test } from "bun:test"
import {
  AGENT_MAX_EVENT_TEXT,
  AGENT_MAX_PAYLOAD_STRING,
  AGENT_PROTOCOL_VERSION,
  type AgentEvent,
  boundAgentText,
  boundAgentValue,
  isAgentEvent,
  splitAgentText,
} from "../src/index.ts"

const REPLACEMENT = String.fromCodePoint(0xfffd)

function message(text: string): AgentEvent {
  return {
    version: AGENT_PROTOCOL_VERSION,
    sessionId: "session",
    seq: 0,
    at: 0,
    type: "assistant.message",
    turnId: "turn",
    text,
  }
}

function toolStarted(input: unknown): AgentEvent {
  return {
    version: AGENT_PROTOCOL_VERSION,
    sessionId: "session",
    seq: 0,
    at: 0,
    type: "tool.started",
    turnId: "turn",
    callId: "call",
    name: "write_file",
    input,
  }
}

describe("splitAgentText", () => {
  test("a reply past one event becomes consecutive valid events that join back", () => {
    const text = "x".repeat(AGENT_MAX_EVENT_TEXT * 2 + 17)
    expect(isAgentEvent(message(text))).toBe(false)
    const pieces = splitAgentText(text)
    expect(pieces).toHaveLength(3)
    expect(pieces.every((piece) => isAgentEvent(message(piece)))).toBe(true)
    expect(pieces.join("")).toBe(text)
  })

  test("short and empty text stay one piece", () => {
    expect(splitAgentText("hello")).toEqual(["hello"])
    expect(splitAgentText("")).toEqual([""])
  })

  test("a piece ends after a line break near its end", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(50)}`
    const pieces = splitAgentText(text, 100)
    expect(pieces[0]).toBe(`${"a".repeat(90)}\n`)
    expect(pieces.join("")).toBe(text)
  })

  test("a line break early in a piece does not shrink it", () => {
    const text = `${"a".repeat(10)}\n${"b".repeat(150)}`
    expect(splitAgentText(text, 100)[0]).toHaveLength(100)
  })

  test("a surrogate pair is never split", () => {
    const text = `${"a".repeat(99)}😀${"b".repeat(10)}`
    const pieces = splitAgentText(text, 100)
    expect(pieces[0]).toBe("a".repeat(99))
    expect(pieces[1]?.startsWith("😀")).toBe(true)
    expect(pieces.join("")).toBe(text)
  })

  test("NUL becomes U+FFFD so every piece validates", () => {
    expect(isAgentEvent(message("a\0b"))).toBe(false)
    expect(splitAgentText("a\0b")).toEqual([`a${REPLACEMENT}b`])
  })

  test("refuses a piece size the protocol cannot carry", () => {
    expect(() => splitAgentText("text", 1)).toThrow(RangeError)
    expect(() => splitAgentText("text", AGENT_MAX_EVENT_TEXT + 1)).toThrow(RangeError)
  })
})

describe("boundAgentText", () => {
  test("cuts long text to the limit with a marker", () => {
    const bounded = boundAgentText("x".repeat(500), 100)
    expect(bounded).toHaveLength(100)
    expect(bounded.endsWith("…[truncated]")).toBe(true)
    expect(boundAgentText("short", 100)).toBe("short")
  })

  test("defaults to the event text limit and replaces NUL", () => {
    const bounded = boundAgentText(`a\0${"x".repeat(AGENT_MAX_EVENT_TEXT)}`)
    expect(bounded).toHaveLength(AGENT_MAX_EVENT_TEXT)
    expect(isAgentEvent(message(bounded))).toBe(true)
  })

  test("does not end on half a surrogate pair", () => {
    const marker = "…[truncated]"
    const text = `${"a".repeat(100 - marker.length - 1)}😀${"tail".repeat(10)}`
    const bounded = boundAgentText(text, 100)
    expect(bounded).toBe(`${"a".repeat(100 - marker.length - 1)}${marker}`)
  })
})

describe("boundAgentValue", () => {
  test("a write_file input with a large body becomes a valid display copy", () => {
    const input = { path: "big.txt", content: "y".repeat(100_000) }
    expect(isAgentEvent(toolStarted(input))).toBe(false)
    const bounded = boundAgentValue(input) as { path: string; content: string }
    expect(isAgentEvent(toolStarted(bounded))).toBe(true)
    expect(bounded.path).toBe("big.txt")
    expect(bounded.content).toHaveLength(AGENT_MAX_PAYLOAD_STRING)
    expect(bounded.content.endsWith("…[truncated]")).toBe(true)
    expect(input.content).toHaveLength(100_000)
  })

  test("a value already within bounds is copied unchanged", () => {
    const input = { path: "a.ts", lines: [1, 2, 3], flags: { force: true, note: null } }
    expect(boundAgentValue(input)).toEqual(input)
  })

  test("long arrays end with a marker for the items left out", () => {
    const bounded = boundAgentValue(Array.from({ length: 300 }, (_, index) => index)) as unknown[]
    expect(bounded).toHaveLength(256)
    expect(bounded.at(-1)).toBe("…[45 more items]")
    expect(isAgentEvent(toolStarted(bounded))).toBe(true)
  })

  test("deep nesting is cut at the protocol depth", () => {
    let deep: unknown = { leaf: true }
    for (let level = 0; level < 10; level++) deep = { child: deep }
    expect(isAgentEvent(toolStarted(deep))).toBe(false)
    expect(isAgentEvent(toolStarted(boundAgentValue(deep)))).toBe(true)
  })

  test("the node budget holds for wide values", () => {
    const wide = Array.from({ length: 256 }, () => Array.from({ length: 20 }, () => 1))
    expect(isAgentEvent(toolStarted(wide))).toBe(false)
    expect(isAgentEvent(toolStarted(boundAgentValue(wide)))).toBe(true)
  })

  test("many large strings share one budget", () => {
    const many = Array.from({ length: 40 }, () => "z".repeat(AGENT_MAX_PAYLOAD_STRING))
    const bounded = boundAgentValue(many) as string[]
    const chars = bounded.reduce((total, item) => total + item.length, 0)
    expect(chars).toBeLessThan(AGENT_MAX_EVENT_TEXT + 40 * 16)
    expect(isAgentEvent(toolStarted(bounded))).toBe(true)
  })

  test("keys the protocol refuses are dropped and __proto__ stays an own key", () => {
    const parsed = JSON.parse(`{"__proto__":{"polluted":true},"":1,"${"k".repeat(129)}":2,"ok":3}`)
    const bounded = boundAgentValue(parsed) as Record<string, unknown>
    expect(Object.keys(bounded)).toEqual(["__proto__", "ok"])
    expect(Object.getPrototypeOf(bounded)).toBe(Object.prototype)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(isAgentEvent(toolStarted(bounded))).toBe(true)
  })

  test("values JSON cannot carry are dropped or made safe", () => {
    const bounded = boundAgentValue({
      gone: undefined,
      fn: () => 1,
      big: 2 ** 60,
      nan: Number.NaN,
      list: [undefined, 1n, "a\0b"],
    })
    expect(bounded).toEqual({
      big: String(2 ** 60),
      nan: null,
      list: [null, null, `a${REPLACEMENT}b`],
    })
    expect(isAgentEvent(toolStarted(bounded))).toBe(true)
    expect(boundAgentValue(undefined)).toBeUndefined()
  })
})
