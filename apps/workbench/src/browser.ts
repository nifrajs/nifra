/**
 * Workbench browser entrypoint: a presentation-safe evidence console.
 *
 * This module is the entire browser bundle. It imports only `@nifrajs/agent-app` - never a backend,
 * provider, store, or host internal - so the shipped JavaScript cannot reconstruct a prompt, tool
 * payload, model completion, diagnostic report, or filesystem path. Everything it renders is
 * content-free: identifiers, lifecycle statuses, counters, and opaque references. The operator's own
 * typed prompt is echoed locally (it is the operator's input, not agent output); the agent side is
 * shown as evidence - how many deltas streamed, whether a tool succeeded, how a gate exited.
 *
 * Host-specific surfaces beyond the negotiated SDK contract (checkpoint, fork, reload, compaction,
 * diff, verification, extension inventories) are reached through the client's bounded `command`
 * escape hatch and projected to content-free fields here at the call site.
 */

import {
  AgentAppClient,
  type AgentEventView,
  type BoundaryItemView,
  boundaryCommands,
  HttpAgentTransport,
  type RegistryCapabilityView,
  toRegistryCapabilityView,
} from "@nifrajs/agent-app"

const params = new URLSearchParams(window.location.search)
const endpoint = params.get("rpc") ?? ""
const token = params.get("token") ?? ""

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`workbench: missing element #${id}`)
  return node as T
}

const ui = {
  project: el("project"),
  connection: el("connection"),
  status: el("status"),
  session: el("session"),
  messages: el("messages"),
  timeline: el("timeline"),
  registry: el("registry"),
  inbox: el("inbox"),
  approvals: el("approvals"),
  verification: el("verification"),
  workflows: el("workflows"),
  subagents: el("subagents"),
  providers: el("providers"),
  uiExtensions: el("ui-extensions"),
  diffStatus: el("diff-status"),
  diffOutput: el("diff-output"),
  history: el("history"),
  composer: el<HTMLFormElement>("composer"),
  prompt: el<HTMLTextAreaElement>("prompt"),
  send: el<HTMLButtonElement>("send"),
}

const transport = new HttpAgentTransport({
  endpoint,
  // Per-request bearer token minted from the launch query; never stored on the transport.
  authorize: () => token,
})
const client = new AgentAppClient(transport)

let busy = false

function setBusy(next: boolean): void {
  busy = next
  ui.send.disabled = next
}

function addTimeline(label: string): void {
  const row = document.createElement("div")
  row.className = "event"
  row.textContent = label
  ui.timeline.prepend(row)
  while (ui.timeline.childElementCount > 200) ui.timeline.lastElementChild?.remove()
}

/** Render a single content-free event view as one evidence line. Never renders payload content. */
function describeEvent(view: AgentEventView): string {
  switch (view.kind) {
    case "assistant.delta":
      return `#${view.seq} assistant.delta · ${view.chars} chars`
    case "assistant.message":
      return `#${view.seq} assistant.message · ${view.chars} chars`
    case "tool.started":
      return `#${view.seq} tool.started · ${view.name}${view.hasInput ? " · input" : ""}`
    case "tool.delta":
      return `#${view.seq} tool.delta · ${view.chars} chars`
    case "tool.completed":
      return `#${view.seq} tool.completed · ${view.ok ? "ok" : `error:${view.errorCode ?? "unknown"}`}`
    case "turn.started":
      return `#${view.seq} turn.started`
    case "approval.required":
      return `#${view.seq} approval.required · ${view.action}`
    case "approval.resolved":
      return `#${view.seq} approval.resolved · ${view.approved ? "approved" : "declined"}`
    case "memory.compacted":
      return `#${view.seq} memory.compacted · ${view.before}->${view.after} tokens`
    case "extension.reloaded":
      return `#${view.seq} extension.reloaded · ${view.loadedCount} loaded / ${view.disabledCount} disabled`
    case "repair.required":
      return `#${view.seq} repair.required · ${view.verification}`
    case "verification.completed":
      return `#${view.seq} verification.completed · ${view.name} · ${view.ok ? "ok" : "failed"}`
    case "session.failed":
      return `#${view.seq} session.failed · ${view.errorCode}${view.recoverable ? " · recoverable" : ""}`
    case "session.stopped":
      return `#${view.seq} session.stopped`
    default:
      return `#${(view as { seq: number }).seq} ${(view as { kind: string }).kind}`
  }
}

function bubble(kind: "user" | "assistant", text: string): HTMLDivElement {
  ui.messages.querySelector(".welcome")?.remove()
  const node = document.createElement("div")
  node.className = `bubble ${kind}`
  node.textContent = text
  ui.messages.append(node)
  ui.messages.scrollTop = ui.messages.scrollHeight
  return node
}

async function connect(): Promise<void> {
  if (endpoint === "" || token === "") {
    ui.connection.textContent = "no launch parameters"
    ui.status.textContent = "Missing rpc/token launch parameters."
    return
  }
  ui.status.textContent = "Opening secure local session…"
  const view = await client.createSession()
  ui.connection.textContent = "connected"
  ui.project.textContent = `${view.backend} backend`
  ui.status.textContent = `Session ${view.id} · ${view.status}`
  ui.session.textContent = `${view.id}\n${view.backend} · seq ${view.lastSeq}\nfeatures: ${client.features.join(", ") || "none"}`
  await Promise.allSettled([
    refreshApprovals(),
    refreshRegistry(),
    refreshInbox(),
    refreshList("workflow.list", "workflows", ui.workflows, "No workflow extensions loaded"),
    refreshList("subagent.list", "subagents", ui.subagents, "No custom roles loaded"),
    refreshList("provider.list", "providers", ui.providers, "No custom providers loaded"),
    refreshUi(),
  ])
}

/**
 * Render the capability registry as content-free identity cards. Reached through the bounded command
 * escape hatch and projected with {@link toRegistryCapabilityView}, so a stray content field on a raw
 * descriptor is dropped rather than shown. Degrades to a stable notice when the host offers no
 * registry (for example when Pi is unavailable).
 */
async function refreshRegistry(): Promise<void> {
  const outcome = await client.command<Record<string, unknown>>("registry.list")
  ui.registry.replaceChildren()
  if (!outcome.ok) {
    ui.registry.textContent = `Registry not offered (${outcome.status})`
    ui.registry.className = "surface-list muted"
    return
  }
  const raw = outcome.value.descriptors ?? outcome.value.capabilities
  const source = Array.isArray(raw) ? raw : []
  const views: RegistryCapabilityView[] = []
  for (const item of source) {
    const view = toRegistryCapabilityView(item)
    if (view !== undefined) views.push(view)
  }
  if (views.length === 0) {
    ui.registry.textContent = "No capabilities registered"
    ui.registry.className = "surface-list muted"
    return
  }
  ui.registry.className = "surface-list"
  for (const view of views) {
    const row = document.createElement("div")
    row.className = "surface-row"
    const label = document.createElement("div")
    const strong = document.createElement("strong")
    strong.textContent = `${view.name} · ${view.kind}`
    const small = document.createElement("small")
    const approval =
      view.approval === "threshold" ? `threshold:${view.approvalLevel}` : view.approval
    // Structural facts only: capability tokens, isolation, approval class, idempotency. No content.
    small.textContent = `${view.requiredCapabilities.join(" · ") || "no capabilities"} · ${view.isolation} · approval:${approval} · ${view.idempotency}`
    label.append(strong, small)
    row.append(label)
    ui.registry.append(row)
  }
}

/**
 * Render the pending decision-boundary inbox. Each item shows its structural coordinate (run, node,
 * capability, child vector, expiry) and lifecycle state - never a prompt, reason, tool payload, model
 * output, or diagnostic. Command buttons appear only for the ops {@link boundaryCommands} reports as
 * currently legal, and each carries the item's exact coordinate so a decision can only ever resolve
 * the boundary it names. Gated on the negotiated `inbox` feature.
 */
async function refreshInbox(): Promise<void> {
  if (!client.supports("inbox")) {
    ui.inbox.textContent = "Inbox not offered by this host"
    ui.inbox.className = "muted"
    return
  }
  const items = await client.listBoundaries()
  ui.inbox.replaceChildren()
  if (items.length === 0) {
    ui.inbox.textContent = "No pending decisions"
    ui.inbox.className = "muted"
    return
  }
  ui.inbox.className = ""
  const now = Date.now()
  for (const item of items) renderBoundary(item, now)
}

function renderBoundary(item: BoundaryItemView, now: number): void {
  const card = document.createElement("div")
  card.className = "approval"
  const title = document.createElement("strong")
  title.textContent = `${item.kind} · ${item.capability}`
  const detail = document.createElement("small")
  const owner = item.to === undefined ? "" : ` · owner ${item.to}`
  // Opaque references only: run/node ids, child vector, request id, state, expiry. No content.
  detail.textContent = `${item.state} · run ${item.runId} · node ${item.nodeId} · v${item.vector} · req ${item.requestId} · expires ${item.expiresAt}${owner}`
  const actions = document.createElement("div")
  actions.className = "approval-actions"
  for (const command of boundaryCommands(item, { inbox: true, now })) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = command
    if (command === "deny" || command === "cancel") button.className = "deny"
    button.addEventListener("click", () => void decideBoundary(item, command))
    actions.append(button)
  }
  card.append(title, detail, actions)
  ui.inbox.append(card)
}

async function decideBoundary(
  item: BoundaryItemView,
  command: ReturnType<typeof boundaryCommands>[number],
): Promise<void> {
  const coordinate = {
    runId: item.runId,
    nodeId: item.nodeId,
    capability: item.capability,
    requestId: item.requestId,
    vector: item.vector,
    expiresAt: item.expiresAt,
  }
  const options =
    command === "assign"
      ? { to: window.prompt("Assign to owner role", "")?.trim() ?? "" }
      : undefined
  if (command === "assign" && (options === undefined || options.to === "")) return
  const result = await client.decideBoundary(command, coordinate, options)
  addTimeline(
    result.ok
      ? `boundary.${command} · ${result.item.state}`
      : `boundary.${command} · refused ${result.code}`,
  )
  await refreshInbox()
}

async function sendPrompt(message: string): Promise<void> {
  bubble("user", message)
  const evidence = bubble("assistant", "streaming…")
  let deltas = 0
  let chars = 0
  let tools = 0
  try {
    for await (const view of client.send(message)) {
      addTimeline(describeEvent(view))
      if (view.kind === "assistant.delta" || view.kind === "assistant.message") {
        deltas++
        chars += view.chars
      } else if (view.kind === "tool.started") tools++
      evidence.textContent = `assistant evidence · ${deltas} deltas · ${chars} chars · ${tools} tool calls`
    }
    if (deltas === 0 && tools === 0)
      evidence.textContent = "assistant evidence · turn produced no events"
    await Promise.allSettled([refreshApprovals(), refreshInbox()])
  } catch (error) {
    evidence.textContent = `turn failed · ${error instanceof Error ? error.message : String(error)}`
  }
}

async function refreshApprovals(): Promise<void> {
  if (!client.supports("approvals")) {
    ui.approvals.textContent = "Approvals not offered by this host"
    return
  }
  const pending = await client.listApprovals()
  ui.approvals.replaceChildren()
  if (pending.length === 0) {
    ui.approvals.textContent = "No pending approvals"
    ui.approvals.className = "muted"
    return
  }
  ui.approvals.className = ""
  for (const approval of pending) {
    const card = document.createElement("div")
    card.className = "approval"
    const title = document.createElement("strong")
    title.textContent = approval.action
    const detail = document.createElement("small")
    detail.textContent = `${approval.capability} · ${approval.approvalId}`
    const actions = document.createElement("div")
    actions.className = "approval-actions"
    const approve = document.createElement("button")
    approve.type = "button"
    approve.textContent = "Approve"
    approve.addEventListener("click", () => void decide(approval.approvalId, true))
    const deny = document.createElement("button")
    deny.type = "button"
    deny.className = "deny"
    deny.textContent = "Decline"
    deny.addEventListener("click", () => void decide(approval.approvalId, false))
    actions.append(approve, deny)
    card.append(title, detail, actions)
    ui.approvals.append(card)
  }
}

async function decide(approvalId: string, approved: boolean): Promise<void> {
  await client.resolveApproval(approvalId, approved)
  addTimeline(`approval.resolved · ${approved ? "approved" : "declined"}`)
  await refreshApprovals()
}

/** Render an inventory surface as identifier chips only, dropping any prose description field. */
async function refreshList(
  method: string,
  key: string,
  target: HTMLElement,
  empty: string,
): Promise<void> {
  const outcome = await client.command<Record<string, unknown>>(method)
  if (!outcome.ok) {
    target.textContent = `${empty} (${outcome.status})`
    target.className = "surface-list muted"
    return
  }
  const raw = outcome.value[key]
  const items = Array.isArray(raw) ? raw : []
  target.replaceChildren()
  if (items.length === 0) {
    target.textContent = empty
    target.className = "surface-list muted"
    return
  }
  target.className = "surface-list"
  for (const item of items) {
    const name = readName(item)
    if (name === undefined) continue
    const row = document.createElement("div")
    row.className = "surface-row"
    const label = document.createElement("div")
    const strong = document.createElement("strong")
    strong.textContent = name
    const small = document.createElement("small")
    small.textContent = readCapabilities(item)
    label.append(strong, small)
    row.append(label)
    target.append(row)
  }
}

function readName(item: unknown): string | undefined {
  if (typeof item === "string") return item
  if (typeof item === "object" && item !== null) {
    const name = (item as Record<string, unknown>).name
    if (typeof name === "string") return name
  }
  return undefined
}

function readCapabilities(item: unknown): string {
  if (typeof item !== "object" || item === null) return ""
  const caps = (item as Record<string, unknown>).capabilities
  return Array.isArray(caps) ? caps.filter((c) => typeof c === "string").join(" · ") : ""
}

async function refreshUi(): Promise<void> {
  const outcome = await client.command<{ revision?: unknown; active?: unknown }>("ui.snapshot")
  if (!outcome.ok) {
    ui.uiExtensions.textContent = "Stable shell · no extensions loaded"
    ui.uiExtensions.className = "surface-list muted"
    return
  }
  const active = Array.isArray(outcome.value.active) ? outcome.value.active : []
  const revision = typeof outcome.value.revision === "string" ? outcome.value.revision : "0"
  ui.uiExtensions.className = "surface-list muted"
  ui.uiExtensions.textContent =
    active.length === 0
      ? `Stable shell · revision ${revision}`
      : `${active.length} UI extension(s) · revision ${revision}`
}

/** Fetch the tracked diff and render only its evidence: ok, status, truncation, line count. */
async function showDiff(): Promise<void> {
  ui.diffStatus.textContent = "Reading tracked changes…"
  const outcome = await client.command<Record<string, unknown>>("project.diff")
  if (!outcome.ok) {
    ui.diffStatus.textContent = `Diff unavailable (${outcome.status})`
    ui.diffOutput.textContent = "No diff evidence"
    return
  }
  const value = outcome.value
  const ok = value.ok === true
  const status = typeof value.status === "number" ? value.status : "n/a"
  const truncated = value.truncated === true
  const lines = typeof value.output === "string" ? value.output.split("\n").length : 0
  ui.diffStatus.textContent = ok ? `Diff read · exit ${status}` : `Diff error · exit ${status}`
  // Evidence only: the diff body is never rendered - just its measured extent.
  ui.diffOutput.textContent = `${lines} changed line(s)${truncated ? " · truncated" : ""}`
}

async function loadHistory(): Promise<void> {
  ui.history.textContent = "Loading bounded session evidence…"
  const outcome = await client.command<Record<string, unknown>>("session.events", { cursor: -1 })
  if (!outcome.ok) {
    ui.history.textContent = `History unavailable (${outcome.status})`
    return
  }
  const resume = outcome.value.resume
  const source = isRecord(resume) && Array.isArray(resume.events) ? resume.events : []
  ui.history.replaceChildren()
  if (source.length === 0) {
    ui.history.textContent = "No retained history"
    ui.history.className = "muted"
    return
  }
  ui.history.className = "history"
  for (const entry of source) {
    if (!isRecord(entry)) continue
    const seq = typeof entry.seq === "number" ? entry.seq : "-"
    const type = typeof entry.type === "string" ? entry.type : "event"
    const row = document.createElement("div")
    row.className = "history-entry"
    row.textContent = `#${seq} ${type}`
    ui.history.append(row)
  }
}

async function checkpoint(): Promise<void> {
  const outcome = await client.command("session.checkpoint")
  addTimeline(
    outcome.ok ? "session.checkpoint · saved" : `session.checkpoint · error ${outcome.status}`,
  )
}

async function fork(): Promise<void> {
  const target = window.prompt("Optional fork session id", "")?.trim() ?? ""
  const outcome = await client.command<Record<string, unknown>>(
    "session.fork",
    target === "" ? undefined : { targetSessionId: target },
  )
  if (!outcome.ok) {
    addTimeline(`session.fork · error ${outcome.status}`)
    return
  }
  // A fork returns a full snapshot; surface only the new session id, never its cwd.
  const id = typeof outcome.value.id === "string" ? outcome.value.id : "unknown"
  addTimeline(`session.forked · ${id}`)
}

async function reload(): Promise<void> {
  const outcome = await client.command<Record<string, unknown>>("session.reload")
  if (!outcome.ok) {
    addTimeline(`session.reload · error ${outcome.status}`)
    return
  }
  const loaded = Array.isArray(outcome.value.loaded) ? outcome.value.loaded.length : 0
  const disabled = Array.isArray(outcome.value.disabled) ? outcome.value.disabled.length : 0
  addTimeline(`session.reload · ${loaded} loaded / ${disabled} disabled`)
  await Promise.allSettled([
    refreshRegistry(),
    refreshInbox(),
    refreshList("workflow.list", "workflows", ui.workflows, "No workflow extensions loaded"),
    refreshList("subagent.list", "subagents", ui.subagents, "No custom roles loaded"),
    refreshList("provider.list", "providers", ui.providers, "No custom providers loaded"),
    refreshUi(),
  ])
}

async function compact(): Promise<void> {
  const outcome = await client.command<Record<string, unknown>>("session.compact")
  if (!outcome.ok) {
    addTimeline(`session.compact · error ${outcome.status}`)
    return
  }
  const before = typeof outcome.value.before === "number" ? outcome.value.before : 0
  const after = typeof outcome.value.after === "number" ? outcome.value.after : 0
  addTimeline(`memory.compacted · ${before}->${after} tokens`)
}

async function verify(name: "check" | "assure"): Promise<void> {
  ui.verification.textContent = `Running ${name}…`
  const outcome = await client.command<Record<string, unknown>>("verification.run", { name })
  if (!outcome.ok) {
    ui.verification.textContent = `${name} unavailable (${outcome.status})`
    return
  }
  const ok = outcome.value.ok === true
  const status = typeof outcome.value.status === "number" ? outcome.value.status : "n/a"
  ui.verification.textContent = `${name}: ${ok ? "passed" : "failed"} · exit ${status}`
  addTimeline(`verification.completed · ${name} · ${ok ? "ok" : "failed"}`)
}

async function uiGraph(method: "ui.preview" | "ui.reload"): Promise<void> {
  const outcome = await client.command<Record<string, unknown>>(method, { manifests: [] })
  addTimeline(outcome.ok ? `${method} · ok` : `${method} · error ${outcome.status}`)
  if (outcome.ok) await refreshUi()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

ui.composer.addEventListener("submit", (event) => {
  event.preventDefault()
  if (busy) return
  const message = ui.prompt.value.trim()
  if (message === "") return
  ui.prompt.value = ""
  setBusy(true)
  void sendPrompt(message).finally(() => setBusy(false))
})

const buttons: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
  ["diff", showDiff],
  ["history-button", loadHistory],
  ["checkpoint", checkpoint],
  ["fork", fork],
  ["reload", reload],
  ["compact", compact],
  ["check", () => verify("check")],
  ["assure", () => verify("assure")],
  ["preview-ui", () => uiGraph("ui.preview")],
  ["reload-ui", () => uiGraph("ui.reload")],
]
for (const [id, action] of buttons)
  el<HTMLButtonElement>(id).addEventListener("click", () => void action())

void connect().catch((error) => {
  ui.connection.textContent = "connection failed"
  ui.status.textContent = error instanceof Error ? error.message : String(error)
})
