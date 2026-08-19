const query = new URLSearchParams(location.search)
const rpc = query.get("rpc")
const token = query.get("token")
const headers = { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json" }
const $ = (id) => document.getElementById(id)
const messages = $("messages")
const timeline = $("timeline")
const status = $("status")
const connection = $("connection")
const session = $("session")
const send = $("send")
const verification = $("verification")
const workflows = $("workflows")
const subagents = $("subagents")
const providers = $("providers")
const uiExtensions = $("ui-extensions")
let assistant = null
const MAX_VISIBLE_MESSAGES = 200
const MAX_VISIBLE_EVENTS = 200

if (!rpc || !token) {
  status.textContent = "Missing local RPC pairing token"
  connection.textContent = "not paired"
  send.disabled = true
} else {
  start().catch((error) => fail(error))
}

for (const [id, action] of [["diff", showDiff], ["history-button", refreshHistory], ["checkpoint", checkpoint], ["fork", fork], ["reload", reload], ["compact", compact], ["check", () => verify("check")], ["assure", () => verify("assure")], ["preview-ui", previewUi], ["reload-ui", reloadUi]]) $(id).addEventListener("click", action)

async function start() {
  const response = await call("session.create")
  const snapshot = await response.json()
  $("project").textContent = snapshot.cwd
  session.textContent = `${snapshot.id} · ${snapshot.backend}`
  status.textContent = "Ready"
  connection.textContent = "secure local"
  await refreshApprovals()
  await refreshHistory()
  await refreshSurfaces()
}

$("composer").addEventListener("submit", async (event) => {
  event.preventDefault()
  const input = $("prompt")
  const message = input.value.trim()
  if (!message || !rpc || !token) return
  input.value = ""
  addBubble("user", message)
  send.disabled = true
  status.textContent = "Agent is working…"
  assistant = null
  try {
    const response = await call("turn.send", { message })
    if (!response.ok) throw new Error(await response.text())
    await readEvents(response)
    status.textContent = "Ready"
  } catch (error) {
    fail(error)
  } finally {
    send.disabled = false
  }
})

async function call(method, params) {
  return fetch(`${rpc}/rpc`, { method: "POST", headers, body: JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) })
}

async function reload() {
  if (!rpc) return
  status.textContent = "Reloading extensions…"
  const response = await call("session.reload")
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  addEvent({ type: "extension.reloaded", seq: "-", ...result })
  status.textContent = result.rolledBack ? "Reload rolled back" : "Ready"
  await refreshSurfaces()
}

async function refreshSurfaces() {
  if (!rpc) return
  const [workflowResponse, subagentResponse, providerResponse, uiResponse] = await Promise.all([call("workflow.list"), call("subagent.list"), call("provider.list"), call("ui.snapshot")])
  if (workflowResponse.ok) {
    const result = await workflowResponse.json()
    renderWorkflows(Array.isArray(result.workflows) ? result.workflows : [])
  }
  if (uiResponse.ok) {
    const result = await uiResponse.json()
    renderUiExtensions(Array.isArray(result.active) ? result.active : [], result.revision)
  }
  if (subagentResponse.ok) {
    const result = await subagentResponse.json()
    renderDescriptors(subagents, Array.isArray(result.subagents) ? result.subagents : [], "No custom roles loaded", "bounded role")
  }
  if (providerResponse.ok) {
    const result = await providerResponse.json()
    renderDescriptors(providers, Array.isArray(result.providers) ? result.providers : [], "No custom providers loaded", "provider port")
  }
}

function renderDescriptors(container, items, empty, detailText) {
  container.replaceChildren()
  if (items.length === 0) {
    container.textContent = empty
    container.className = "surface-list muted"
    return
  }
  container.className = "surface-list"
  for (const item of items.slice(0, 32)) {
    const row = document.createElement("div")
    row.className = "surface-row"
    const copy = document.createElement("div")
    const title = document.createElement("strong")
    title.textContent = item.name
    const detail = document.createElement("small")
    detail.textContent = item.description || detailText
    copy.append(title, detail)
    row.append(copy)
    container.append(row)
  }
}

function renderWorkflows(names) {
  workflows.replaceChildren()
  if (names.length === 0) {
    workflows.textContent = "No workflow extensions loaded"
    workflows.className = "surface-list muted"
    return
  }
  workflows.className = "surface-list"
  for (const name of names.slice(0, 32)) {
    const row = document.createElement("div")
    row.className = "surface-row"
    const copy = document.createElement("div")
    const title = document.createElement("strong")
    title.textContent = name
    const detail = document.createElement("small")
    detail.textContent = "bounded workflow"
    copy.append(title, detail)
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = "Run"
    button.addEventListener("click", () => runWorkflow(name))
    row.append(copy, button)
    workflows.append(row)
  }
}

function renderUiExtensions(manifests, revision) {
  uiExtensions.replaceChildren()
  if (manifests.length === 0) {
    uiExtensions.textContent = `Stable shell · graph ${revision ?? "0"}`
    uiExtensions.className = "surface-list muted"
    return
  }
  uiExtensions.className = "surface-list"
  for (const manifest of manifests.slice(0, 32)) {
    const row = document.createElement("div")
    row.className = "surface-row"
    const copy = document.createElement("div")
    const title = document.createElement("strong")
    title.textContent = manifest.label ?? manifest.id
    const detail = document.createElement("small")
    detail.textContent = `${manifest.slot ?? "main"} · ${manifest.revision ?? "unknown"}${manifest.status?.text ? ` · ${manifest.status.text}` : ""}${manifest.theme?.name ? ` · theme:${manifest.theme.name}` : ""}`
    copy.append(title, detail)
    row.append(copy)
    uiExtensions.append(row)
  }
}

async function runWorkflow(name) {
  status.textContent = `Running ${name}…`
  const response = await call("workflow.run", { name })
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  addEvent({ type: result.ok ? "workflow.completed" : "workflow.failed", seq: "-", name, ...result })
  status.textContent = result.ok ? `${name} complete` : `${name} failed`
  await refreshHistory()
}

async function reloadUi() {
  if (!rpc) return
  status.textContent = "Revalidating UI graph…"
  const current = await call("ui.snapshot")
  if (!current.ok) return fail(new Error(await current.text()))
  const result = await current.json()
  const response = await call("ui.reload", { manifests: Array.isArray(result.active) ? result.active : [] })
  if (!response.ok) return fail(new Error(await response.text()))
  const reloaded = await response.json()
  renderUiExtensions(reloaded.active ?? [], reloaded.revision)
  addEvent({ type: "ui.reloaded", seq: "-", revision: reloaded.revision, rolledBack: reloaded.rolledBack })
  status.textContent = reloaded.rolledBack ? "UI graph rolled back" : "UI graph verified"
}

async function previewUi() {
  if (!rpc) return
  status.textContent = "Previewing UI graph…"
  const current = await call("ui.snapshot")
  if (!current.ok) return fail(new Error(await current.text()))
  const result = await current.json()
  const response = await call("ui.preview", { manifests: Array.isArray(result.active) ? result.active : [] })
  if (!response.ok) return fail(new Error(await response.text()))
  const preview = await response.json()
  renderUiExtensions(preview.active ?? [], preview.revision)
  addEvent({ type: "ui.preview", seq: "-", revision: preview.revision, rolledBack: preview.rolledBack })
  status.textContent = preview.rolledBack ? "UI preview rejected" : "UI preview ready"
}

async function compact() {
  if (!rpc) return
  const response = await call("session.compact")
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  addEvent({ type: "memory.compacted", seq: "-", ...result })
  await refreshHistory()
}

async function checkpoint() {
  if (!rpc) return
  status.textContent = "Saving checkpoint…"
  const response = await call("session.checkpoint")
  if (!response.ok) return fail(new Error(await response.text()))
  addEvent({ type: "session.checkpoint", seq: "-" })
  status.textContent = "Checkpoint saved"
  await refreshHistory()
}

async function fork() {
  if (!rpc) return
  const targetSessionId = window.prompt("Optional fork session id", "")?.trim() ?? ""
  status.textContent = "Creating fork…"
  const response = await call("session.fork", targetSessionId ? { targetSessionId } : undefined)
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  addEvent({ type: "session.forked", seq: "-", ...result })
  session.textContent = `${session.textContent} · fork ${result.sessionId}`
  status.textContent = "Fork created"
  await refreshHistory()
}

async function showDiff() {
  if (!rpc) return
  status.textContent = "Reading workspace diff…"
  const response = await call("project.diff")
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  const output = typeof result.output === "string" ? result.output : (result.error ?? "No tracked changes")
  const visible = output.length > 200_000 ? `${output.slice(0, 200_000)}\n…[Workbench display limit]` : output
  $("diff-output").textContent = visible || "No tracked changes"
  $("diff-status").textContent = `${result.ok ? "git diff completed" : "git diff failed"} · ${output.length} chars${result.truncated ? " · bounded" : ""}`
  addEvent({ type: "project.diff", seq: "-", ok: result.ok, truncated: result.truncated === true })
  status.textContent = "Ready"
}

async function refreshHistory() {
  if (!rpc) return
  const response = await call("session.events", { limit: 80 })
  if (!response.ok) return
  const result = await response.json()
  const container = $("history")
  container.replaceChildren()
  const entries = Array.isArray(result.entries) ? result.entries.slice().reverse() : []
  if (entries.length === 0) {
    container.textContent = "No session evidence yet"
    container.className = "muted"
    return
  }
  container.className = "history"
  for (const entry of entries) {
    const item = document.createElement("div")
    item.className = "history-entry"
    const sequence = document.createElement("span")
    sequence.textContent = String(entry.seq)
    const type = document.createElement("span")
    type.textContent = String(entry.type)
    if (entry.pinned === true) type.className = "pinned"
    item.append(sequence, type)
    container.append(item)
  }
}

async function verify(name) {
  if (!rpc) return
  status.textContent = `Running ${name}…`
  const response = await call("verification.run", { name })
  if (!response.ok) return fail(new Error(await response.text()))
  const result = await response.json()
  verification.textContent = `${name}: ${result.ok ? "passed" : "failed"}${result.status === null ? "" : ` · exit ${result.status}`}`
  addEvent({ type: "verification.completed", seq: "-", name, ...result })
  status.textContent = "Ready"
}

async function refreshApprovals() {
  if (!rpc) return
  const response = await call("approval.list")
  if (!response.ok) return
  const result = await response.json()
  const container = $("approvals")
  container.replaceChildren()
  if (!Array.isArray(result.pending) || result.pending.length === 0) {
    container.textContent = "No pending approvals"
    container.className = "muted"
    return
  }
  container.className = ""
  for (const approval of result.pending) {
    const item = document.createElement("div")
    item.className = "approval"
    const title = document.createElement("strong")
    title.textContent = approval.action
    const detail = document.createElement("small")
    detail.textContent = `${approval.capability}${approval.reason ? ` · ${approval.reason}` : ""}`
    const actions = document.createElement("div")
    actions.className = "approval-actions"
    for (const [label, approved, className] of [["Approve", true, ""], ["Deny", false, "deny"]]) {
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = label
      if (className) button.className = className
      button.addEventListener("click", () => resolveApproval(approval.id, approved))
      actions.append(button)
    }
    item.append(title, detail, actions)
    container.append(item)
  }
}

async function resolveApproval(approvalId, approved) {
  const response = await call("approval.resolve", { approvalId, approved })
  if (!response.ok) {
    fail(new Error(await response.text()))
    return
  }
  addEvent({ type: "approval.resolved", seq: "-", approvalId, approved })
  await refreshApprovals()
}

async function readEvents(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const line = frame.split("\n").find((item) => item.startsWith("data: "))
      if (!line) continue
      const event = JSON.parse(line.slice(6))
      addEvent(event)
    }
  }
}

function addEvent(event) {
  const item = document.createElement("div")
  item.className = "event"
  item.textContent = `${event.type} · ${event.seq}`
  timeline.prepend(item)
  while (timeline.children.length > MAX_VISIBLE_EVENTS) timeline.lastElementChild?.remove()
  if (event.type === "assistant.delta") {
    if (!assistant) assistant = addBubble("assistant", "")
    assistant.textContent += event.text
    messages.scrollTop = messages.scrollHeight
  }
  if (event.type === "session.updated" || event.type === "session.completed") session.textContent = `${event.snapshot.id} · ${event.snapshot.status}`
  if (event.type === "verification.completed") verification.textContent = `${event.name}: ${event.ok ? "passed" : "failed"}`
  if (event.type === "approval.required") refreshApprovals().catch(() => {})
}

function addBubble(kind, text) {
  const empty = messages.querySelector(".welcome")
  empty?.remove()
  const bubble = document.createElement("div")
  bubble.className = `bubble ${kind}`
  bubble.textContent = text
  messages.append(bubble)
  while (messages.children.length > MAX_VISIBLE_MESSAGES) messages.firstElementChild?.remove()
  messages.scrollTop = messages.scrollHeight
  return bubble
}

function fail(error) {
  status.textContent = "Agent unavailable"
  connection.textContent = "error"
  addBubble("assistant", `Workbench error: ${error instanceof Error ? error.message : String(error)}`)
}
