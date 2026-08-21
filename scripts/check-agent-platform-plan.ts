import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const PLAN = ".planning/agent-platform/PROGRAM-PLAN.md"
const REQUIREMENTS = ".planning/agent-platform/REQUIREMENTS.md"
const ARTIFACTS = [
  PLAN,
  ".planning/agent-platform/ROADMAP.md",
  REQUIREMENTS,
  ".planning/agent-platform/RESEARCH.md",
] as const

export interface AgentPlatformPlanAudit {
  readonly ok: boolean
  readonly taskCount: number
  readonly requirementCount: number
  readonly owners: number
  readonly failures: readonly string[]
}

const ID = /^[A-Z]{2,3}-[0-9]{2}$/
const TASK = /^P[0-7]-T[1-3]$/
const NON_ASCII_DASH = /[\u2010-\u2015\u2212]/u

function requirementRows(text: string): Map<string, number> {
  const rows = new Map<string, number>()
  for (const line of text.split("\n")) {
    const match = line.match(/^\|\s*([A-Z]{2,3}-\d{2})\s*\|.*\|\s*([0-7])\s*\|\s*$/)
    if (match !== null) rows.set(match[1]!, Number(match[2]))
  }
  return rows
}

interface TaskRecord {
  readonly id: string
  readonly requirements: readonly string[]
  readonly allowlist: readonly string[]
}

function tasks(text: string): TaskRecord[] {
  const records: TaskRecord[] = []
  const pattern = /^#### Task (P\d+-T\d+):[^\n]*\n([\s\S]*?)(?=^#### Task |^## )/gm
  for (const match of `${text}\n## __TASK_END__\n`.matchAll(pattern)) {
    const body = match[2] ?? ""
    const requirementLine = body.match(/^\*\*Requirement IDs:\*\*\s*(.+)$/m)?.[1] ?? ""
    const allowlistLine = body.match(/^\*\*Write allowlist:\*\*\s*(.+)$/m)?.[1] ?? ""
    const requirements = [...requirementLine.matchAll(/[A-Z]{2,3}-\d{2}/g)].map((item) => item[0])
    const allowlist = [...allowlistLine.matchAll(/`([^`]+)`/g)].map((item) => item[1]!)
    records.push({ id: match[1]!, requirements, allowlist })
  }
  return records
}

export function allowlistForTask(root: string = ROOT, taskId: string): readonly string[] {
  const task = tasks(readFileSync(resolve(root, PLAN), "utf8")).find((item) => item.id === taskId)
  return task?.allowlist ?? []
}

function validAllowlistPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith("/") === false &&
    !path.includes("..") &&
    !/[\\;<>]/u.test(path) &&
    [...path].every((character) => character.charCodeAt(0) >= 0x20)
  )
}

export function auditAgentPlatformPlan(root = ROOT): AgentPlatformPlanAudit {
  const failures: string[] = []
  const plan = readFileSync(resolve(root, PLAN), "utf8")
  const requirementsText = readFileSync(resolve(root, REQUIREMENTS), "utf8")
  const requirementOwners = requirementRows(requirementsText)
  const records = tasks(plan)
  const allRequirementIds = new Set(requirementOwners.keys())
  const counts = new Map<string, number>()

  if (records.length !== 24) failures.push(`expected 24 tasks, found ${records.length}`)
  const taskIds = new Set<string>()
  for (const task of records) {
    if (!TASK.test(task.id)) failures.push(`invalid task id: ${task.id}`)
    if (taskIds.has(task.id)) failures.push(`duplicate task id: ${task.id}`)
    taskIds.add(task.id)
    if (task.requirements.length === 0) failures.push(`${task.id}: missing requirement IDs`)
    if (task.allowlist.length === 0) failures.push(`${task.id}: missing write allowlist`)
    for (const path of task.allowlist)
      if (!validAllowlistPath(path)) failures.push(`${task.id}: invalid allowlist path ${path}`)
    const phase = Number(task.id.slice(1, 2))
    for (const id of task.requirements) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      if (!ID.test(id) || !allRequirementIds.has(id))
        failures.push(`${task.id}: unknown requirement ${id}`)
      else if (requirementOwners.get(id) !== phase)
        failures.push(
          `${task.id}: ${id} belongs to phase ${requirementOwners.get(id)}, not ${phase}`,
        )
    }
  }
  for (const [id, count] of counts) if (count !== 1) failures.push(`${id}: owned ${count} times`)
  for (const id of allRequirementIds)
    if (!counts.has(id)) failures.push(`${id}: missing task owner`)
  if (allRequirementIds.size !== 88)
    failures.push(`expected 88 requirements, found ${allRequirementIds.size}`)
  for (let phase = 0; phase < 8; phase++) {
    const phaseTasks = records.filter((task) => Number(task.id.slice(1, 2)) === phase)
    if (phaseTasks.length !== 3)
      failures.push(`phase ${phase}: expected 3 tasks, found ${phaseTasks.length}`)
  }
  for (const artifact of ARTIFACTS) {
    const text = readFileSync(resolve(root, artifact), "utf8")
    if (NON_ASCII_DASH.test(text)) failures.push(`${artifact}: non-ASCII dash code point`)
  }
  return {
    ok: failures.length === 0,
    taskCount: records.length,
    requirementCount: allRequirementIds.size,
    owners: counts.size,
    failures: Object.freeze(failures),
  }
}

if (import.meta.main) {
  const report = auditAgentPlatformPlan()
  if (!report.ok) {
    for (const failure of report.failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  console.log(
    `✓ agent-platform plan: ${report.taskCount} tasks, ${report.owners}/${report.requirementCount} requirements owned`,
  )
}
