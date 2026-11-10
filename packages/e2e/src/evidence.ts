import { INTERACTIVE } from "./snapshot.ts"

/** Roles whose text is what the user typed, which differs per run and says nothing about the page. */
const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"])
const STATE_ATTRS = /^(?:checked|selected|expanded|pressed)\b/
const LINE = /^- (\w+)( "(?:[^"\\]|\\.)*")?((?: \[[^\]]*\])*)(?::\s?(.*))?$/s
const MAX_LINES = 30

/** A control or heading, its name and its checked/selected/expanded/pressed state; typed text left out. */
function evidenceLine(line: string): string | undefined {
  if (!INTERACTIVE.test(line)) return undefined
  const trimmed = line.trim()
  const parts = LINE.exec(trimmed)
  if (parts === null) return trimmed
  const [, role = "", name = "", attrs = "", tail = ""] = parts
  const states = [...attrs.matchAll(/ \[([^\]]*)\]/g)]
    .map((match) => match[1] ?? "")
    .filter((attr) => STATE_ATTRS.test(attr))
    .map((attr) => ` [${attr}]`)
    .join("")
  const text = INPUT_ROLES.has(role) || tail === "" ? "" : `: ${tail}`
  return `- ${role}${name}${states}${text}`
}

function evidenceLines(snapshot: string): string[] {
  const out: string[] = []
  for (const line of snapshot.split("\n")) {
    const kept = evidenceLine(line)
    if (kept !== undefined && !out.includes(kept)) out.push(kept)
  }
  return out
}

export interface Evidence {
  readonly appeared: readonly string[]
  readonly disappeared: readonly string[]
}

/** What the action changed on the page, as controls and headings that came or went, in page order. */
export function diffEvidence(before: string, after: string): Evidence {
  const was = evidenceLines(before)
  const now = evidenceLines(after)
  return {
    appeared: now.filter((line) => !was.includes(line)).slice(0, MAX_LINES),
    disappeared: was.filter((line) => !now.includes(line)).slice(0, MAX_LINES),
  }
}

export type EvidenceCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string }

export function checkEvidence(evidence: Evidence, snapshot: string): EvidenceCheck {
  const now = evidenceLines(snapshot)
  const missing = evidence.appeared.find((line) => !now.includes(line))
  if (missing !== undefined) return { ok: false, detail: `expected ${missing} to be on the page` }
  const lingering = evidence.disappeared.find((line) => now.includes(line))
  if (lingering !== undefined) return { ok: false, detail: `expected ${lingering} to be gone` }
  return { ok: true }
}
