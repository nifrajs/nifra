type MessageRole = "bot" | "user"

interface DocSection {
  readonly heading: string
  readonly body: string
}

interface TopicAnswer {
  readonly triggers: readonly string[]
  readonly answer: string
}

const POSITION_KEY = "nifra-bot-position"
const MAX_MESSAGES = 28

const SECTION_TIPS: Record<string, string> = {
  hero: "Nifra gives you a fast backend, full-stack SSR, and agent-ready tooling from one codebase.",
  "sec-agent":
    "Agent feature: expose typed routes as MCP tools so coding agents can inspect, run, and fix with less context.",
  "sec-client":
    "Typed client: params, query, body, and response payloads are inferred directly from your server routes.",
  "sec-frontend":
    "Use React, Solid, Vue, Preact, or Svelte with the same loaders, actions, streaming, and islands.",
  "sec-runtime":
    "Ship the same app to Bun, Node, Deno, Cloudflare Workers, Vercel, and static prerender targets.",
  "sec-backend":
    "Backend features include route schemas, middleware, cookies, sessions, WebSockets, OpenAPI, uploads, cron, and telemetry.",
  "sec-ecosystem":
    "Plugins add auth, env validation, images, uploads, i18n, cron, OpenTelemetry, Drizzle, and more.",
  "sec-benchmarks":
    "Benchmarks show Nifra keeps tiny HTTP overhead and strong full-stack SSR throughput.",
  "sec-timeline":
    "Types flow from route definitions into clients, docs, tests, MCP tools, and app code.",
  "sec-cta":
    "One command scaffolds a typed Nifra app: bun create nifra my-app. Start as an API, grow into full-stack SSR.",
}

const TOPICS: readonly TopicAnswer[] = [
  {
    triggers: ["mcp", "agent", "agents", "tool", "tools", "coding agent"],
    answer:
      "Feature: Nifra can expose your app as an MCP server for coding agents. How to use: run the CLI MCP command from a Nifra project so agents can list routes, inspect schemas, call safe dev tools, and work with compact project context.",
  },
  {
    triggers: ["typed client", "type safe", "typesafe", "response", "client", "api client"],
    answer:
      "Feature: the typed client is inferred from your server routes. How to use: define routes with schemas, export the app type, then call the client instead of hand-written fetch wrappers. Params, query, body, status branches, and response data stay connected to the server definition.",
  },
  {
    triggers: ["island", "islands", "hydration", "client script", "interactive"],
    answer:
      "Feature: islands let static SSR pages add focused client behavior only where needed. How to use: render normal HTML first, attach an island script to the route, and keep the browser code scoped to that widget instead of hydrating the whole page.",
  },
  {
    triggers: [
      "runtime",
      "runtimes",
      "deploy",
      "deployment",
      "bun",
      "node",
      "deno",
      "worker",
      "workers",
      "cloudflare",
      "vercel",
      "edge",
    ],
    answer:
      "Feature: the same Nifra app can target Bun, Node, Deno, Cloudflare Workers, Vercel, and static prerender output. How to use: keep app logic in Nifra routes and choose the deployment adapter or build preset for the host.",
  },
  {
    triggers: ["websocket", "websockets", "web socket", "ws", "upgrade", "realtime", "pub/sub"],
    answer:
      "Feature: Nifra supports WebSocket routes beside HTTP routes. How to use: define an upgrade route, validate the connection inputs like normal route data, and keep realtime handlers in the same typed app model.",
  },
  {
    triggers: ["security", "secure", "auth", "cookie", "cookies", "csrf", "rate limit", "cors"],
    answer:
      "Feature: Nifra ships production-oriented middleware for auth, cookies, CORS, rate limiting, security headers, validation, and typed errors. How to use: compose middleware at the app or route boundary and keep untrusted input behind schemas.",
  },
  {
    triggers: ["schema", "validation", "validate", "openapi", "swagger"],
    answer:
      "Feature: schemas validate runtime inputs and produce TypeScript types and OpenAPI output. How to use: attach schemas to params, query, body, and responses so handlers receive typed values and invalid requests fail before business logic runs.",
  },
  {
    triggers: ["hmr", "hot reload", "dev server", "vite", "fast refresh"],
    answer:
      "Feature: nifra dev gives you a state-preserving UI dev loop for supported adapters. How to use: add the official framework Vite plugin in your Nifra dev config, then run nifra dev. React, Preact, and Vue preserve edited component state; Solid and Svelte update live and may remount the edited component.",
  },
  {
    triggers: [
      "benchmark",
      "performance",
      "fast",
      "throughput",
      "req/s",
      "elysia",
      "hono",
      "fastify",
    ],
    answer:
      "Feature: Nifra publishes reproducible HTTP and SSR benchmarks in the repo and on the site. How to use: run the benchmark scripts locally on your machine, compare the generated tables, and treat the numbers as throughput evidence for the tested routes and runtimes.",
  },
  {
    triggers: [
      "frontend",
      "react",
      "solid",
      "vue",
      "preact",
      "svelte",
      "loader",
      "action",
      "streaming",
    ],
    answer:
      "Feature: Nifra gives five UI frameworks the same full-stack primitives. How to use: pick an adapter, create file routes, export loaders and actions, then use streaming, deferred data, fetchers, query cache, forms, and islands with that framework's normal component style.",
  },
]

// High-level intents matched ahead of the per-feature TOPICS: identity ("who are you"), what-is,
// features, use-cases, and getting-started. Multi-word triggers match as a phrase and score higher,
// so a specific question wins; single-word triggers match on word boundaries (no "this"→"hi").
const INTENTS: readonly TopicAnswer[] = [
  {
    triggers: [
      "who are you",
      "what are you",
      "your name",
      "who is nira",
      "what is nira",
      "are you nira",
      "are you a bot",
      "are you human",
      "are you ai",
      "who made you",
      "your purpose",
      "what do you do",
      "nira",
    ],
    answer:
      'I\'m Nira, your guide to Nifra — a small built-in bot, not a person. I can explain what Nifra is, walk through its features, and show you how to get started. Try: "What is Nifra?", "What are the main features?", or "How do I get started?"',
  },
  {
    triggers: ["hi", "hello", "hey", "hiya", "yo", "greetings", "howdy"],
    answer:
      "Hi! I'm Nira, your guide to Nifra. Ask me what Nifra is, its features, the typed client, runtimes, security, or how to get started.",
  },
  {
    triggers: [
      "what is nifra",
      "whats nifra",
      "about nifra",
      "explain nifra",
      "tell me about nifra",
      "what does nifra do",
      "what is this",
      "nifra overview",
      "intro to nifra",
    ],
    answer:
      'Nifra is an AI-native TypeScript framework. From one codebase you build typed APIs and full-stack apps: define routes with schemas, get a no-codegen typed client, render SSR with React, Solid, Vue, Preact, or Svelte, and deploy to Bun, Node, Deno, Cloudflare, or Vercel. It also exposes your live API to coding agents over MCP. Ask about a feature, or "How do I get started?"',
  },
  {
    triggers: [
      "features",
      "feature list",
      "capabilities",
      "what can nifra do",
      "what can it do",
      "main features",
      "everything it does",
    ],
    answer:
      "Nifra's core features: typed routes with schema validation, a no-codegen typed client, multi-framework SSR (React/Solid/Vue/Preact/Svelte), multi-runtime deploy (Bun/Node/Deno/Cloudflare/Vercel), zero-JS islands, an MCP server for coding agents, and built-in middleware for auth, cookies, CSRF, JWT, rate limiting, CORS, and WebSockets. Plugins add uploads, cron, OpenTelemetry, env validation, images, i18n, and content/MDX. Ask about any one.",
  },
  {
    triggers: [
      "use case",
      "use cases",
      "what is it for",
      "whats it for",
      "what is it used for",
      "when to use",
      "why use",
      "why nifra",
      "good for",
      "should i use",
      "uses",
    ],
    answer:
      "Use Nifra to build a typed JSON API on its own (like Hono or Elysia), or a full-stack SSR app where the frontend and backend share types with no codegen. It fits well when you want one app across many runtimes, or when coding agents edit your code and need a live, typed view of the API. Ask about a specific feature to go deeper.",
  },
  {
    triggers: [
      "get started",
      "getting started",
      "install",
      "setup",
      "set up",
      "create",
      "scaffold",
      "quickstart",
      "quick start",
      "how do i start",
      "how to start",
      "new project",
      "begin",
    ],
    answer:
      "Run `bun create nifra my-app` to scaffold a typed app, then `bun dev` to start. Add routes with `server().get(...)`, validate inputs with `t`, and call them from the typed client. See the Getting Started docs, or try the in-browser Playground at /play.",
  },
]

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "ask",
  "about",
  "be",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "nifra",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "what",
  "with",
  // Conversational filler — these show up in off-topic questions and (sometimes) in doc headings,
  // so dropping them keeps the doc search from matching on a generic word like "you" or "work".
  "you",
  "your",
  "yours",
  "we",
  "us",
  "our",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "like",
  "want",
  "need",
  "please",
  "tell",
  "give",
  "show",
  "know",
  "think",
  "make",
  "get",
  "got",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "did",
  "done",
  "work",
  "works",
  "working",
  "when",
  "where",
  "who",
  "why",
  "which",
  "some",
  "any",
  "all",
  "more",
  "most",
  "very",
  "really",
  "just",
  "also",
  "then",
  "than",
])

const SECTION_BLOCKLIST = [
  "why vite",
  "why migrate",
  "why a seam",
  "one more difference",
  "dead-code",
  "import.meta.hot",
  "born from",
  "under the hood",
  "internals",
  "rationale",
  "history",
  "trade-off",
  "tradeoff",
]

let docsPromise: Promise<readonly DocSection[]> | undefined
// Last resolved homepage section *id* (e.g. "sec-agent") — the fallback when no section is in band.
// Kept distinct from the displayed tip text so scroll updates resolve the right section every time.
let lastSectionId = "hero"
let suppressNextClick = false
let drag:
  | {
      pointerId: number
      startX: number
      startY: number
      left: number
      top: number
      moved: boolean
    }
  | undefined

const byId = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null

function cleanText(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.{3,}|…/g, "")
    .trim()
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string
    id?: string
    text?: string
    type?: string
    label?: string
  } = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (options.className) el.className = options.className
  if (options.id) el.id = options.id
  if (options.text) el.textContent = options.text
  if (options.type && "type" in el) (el as HTMLButtonElement | HTMLInputElement).type = options.type
  if (options.label) el.setAttribute("aria-label", options.label)
  return el
}

function ensureShell(): void {
  if (byId("nifra-bot-container")) return

  const container = make("div", { className: "nifra-bot-container", id: "nifra-bot-container" })
  container.dataset.open = "false"

  const panel = make("section", { className: "nifra-bot-panel", id: "nifra-bot-panel" })
  panel.setAttribute("aria-label", "Nira chat guide")
  panel.hidden = true

  const head = make("div", { className: "nifra-bot-panel-head" })
  const titleWrap = make("div")
  titleWrap.append(make("strong", { text: "Nira" }))
  titleWrap.append(make("span", { text: "Docs & feature guide" }))
  const close = make("button", {
    className: "nifra-bot-close",
    id: "nifra-bot-close",
    label: "Collapse Nira",
    text: "×",
    type: "button",
  })
  head.append(titleWrap, close)

  const messages = make("div", { className: "nifra-bot-messages", id: "nifra-bot-messages" })
  messages.setAttribute("role", "log")
  messages.setAttribute("aria-live", "polite")
  messages.setAttribute("aria-relevant", "additions")
  messages.append(
    make("p", {
      className: "nifra-bot-message bot",
      text: "Hi, I'm Nira — Nifra's docs guide. I'm a tiny island myself: static HTML first, one focused client script after. Ask me about MCP, typed clients, islands, runtimes, security, or benchmarks.",
    }),
  )

  const quick = make("fieldset", { className: "nifra-bot-quick" })
  quick.append(make("legend", { className: "nifra-bot-sr", text: "Suggested questions for Nira" }))
  for (const [label, question] of [
    ["Agent MCP", "How does Nifra help coding agents?"],
    ["Islands", "How do Nifra islands work?"],
    ["Typed client", "Is the typed client type safe?"],
  ] as const) {
    const button = make("button", { text: label, type: "button" })
    button.dataset.nifraQuestion = question
    quick.append(button)
  }

  const form = make("form", { className: "nifra-bot-form", id: "nifra-bot-form" })
  const label = make("label", { className: "nifra-bot-sr", text: "Ask Nifra Bot" })
  label.setAttribute("for", "nifra-bot-input")
  const input = make("input", { id: "nifra-bot-input" })
  input.name = "question"
  input.autocomplete = "off"
  input.maxLength = 180
  input.placeholder = "Ask Nira about Nifra..."
  const send = make("button", { label: "Send question", text: "Send", type: "submit" })
  form.append(label, input, send)

  panel.append(head, messages, quick, form)

  const bubbleWrap = make("div", { className: "nifra-bubble-container visible" })
  bubbleWrap.append(
    make("div", {
      className: "nifra-bubble",
      id: "nifra-bubble",
      text: "Hi, I'm Nira — scroll for tips, or tap me to ask about Nifra.",
    }),
  )

  const bot = make("button", {
    className: "nifra-bot",
    id: "nifra-bot",
    label: "Toggle Nira chat",
    type: "button",
  })
  bot.setAttribute("aria-controls", "nifra-bot-panel")
  bot.setAttribute("aria-expanded", "false")
  const avatar = make("img", { className: "nifra-bot-avatar" })
  avatar.src = "/assets/nifra-bot-avatar.png"
  avatar.alt = ""
  avatar.width = 76
  avatar.height = 76
  avatar.draggable = false
  bot.append(avatar)

  container.append(panel, bubbleWrap, bot)
  document.body.append(container)
}

function words(value: string): readonly string[] {
  return cleanText(value.toLowerCase())
    .split(/[^a-z0-9/+.-]+/g)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}

function isBlockedSection(section: DocSection): boolean {
  const haystack = `${section.heading}\n${section.body}`.toLowerCase()
  return SECTION_BLOCKLIST.some((term) => haystack.includes(term))
}

function parseDocs(source: string): readonly DocSection[] {
  const sections: DocSection[] = []
  let heading = "Nifra"
  let body: string[] = []

  const push = () => {
    const cleaned = cleanText(
      body
        .join("\n")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^[-*]\s+/gm, "")
        .replace(/^#+\s+/gm, ""),
    )
    if (cleaned.length > 40) sections.push({ heading: cleanText(heading), body: cleaned })
  }

  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^(#{2,4})\s+(.+)$/.exec(line)
    if (match) {
      push()
      heading = match[2] ?? "Nifra"
      body = []
    } else {
      body.push(line)
    }
  }
  push()
  return sections.filter((section) => !isBlockedSection(section))
}

async function loadDocs(): Promise<readonly DocSection[]> {
  docsPromise ??= fetch("/llms-full.txt", { cache: "force-cache" })
    .then((response) => (response.ok ? response.text() : ""))
    .then(parseDocs)
    .catch(() => [])
  return docsPromise
}

function splitSentences(value: string): readonly string[] {
  return (
    cleanText(value)
      .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
      ?.map(cleanText)
      .filter(Boolean) ?? []
  )
}

// Match the question against INTENTS (identity/what-is/features/…) then the per-feature TOPICS.
// Multi-word triggers match as a phrase (weight 2 — more specific); single-word triggers match a
// whole word from the question (weight 1), so "this" never matches "hi".
const INTENT_TABLE: readonly TopicAnswer[] = [...INTENTS, ...TOPICS]

function topicAnswer(question: string): string | undefined {
  const normalized = cleanText(question.toLowerCase())
  const wordSet = new Set(normalized.split(/[^a-z0-9/]+/).filter(Boolean))
  let best: TopicAnswer | undefined
  let bestScore = 0
  for (const topic of INTENT_TABLE) {
    let score = 0
    for (const trigger of topic.triggers) {
      if (trigger.includes(" ")) {
        if (normalized.includes(trigger)) score += 2
      } else if (wordSet.has(trigger)) {
        score += 1
      }
    }
    if (score > bestScore) {
      best = topic
      bestScore = score
    }
  }
  return bestScore > 0 ? best?.answer : undefined
}

function sectionAnswer(question: string, sections: readonly DocSection[]): string | undefined {
  const terms = words(question)
  if (terms.length === 0) return undefined

  let best: DocSection | undefined
  let bestScore = 0
  for (const section of sections) {
    const heading = section.heading.toLowerCase()
    const body = section.body.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (heading.includes(term)) score += 5
      if (body.includes(term)) score += 1
    }
    if (score > bestScore) {
      best = section
      bestScore = score
    }
  }
  // Require a real topical hit — a query term in a section heading scores 5. An off-topic question
  // with only an incidental body word (score 1) falls through to the off-topic redirect instead.
  if (!best || bestScore < 5) return undefined

  const sentences = splitSentences(best.body)
  const picked = sentences
    .filter((sentence) => terms.some((term) => sentence.toLowerCase().includes(term)))
    .slice(0, 3)
  const answer = cleanText((picked.length > 0 ? picked : sentences.slice(0, 3)).join(" "))
  return answer ? `Feature: ${best.heading}. ${answer}` : undefined
}

async function answerQuestion(question: string): Promise<string> {
  const canned = topicAnswer(question)
  if (canned) return canned

  const fromDocs = sectionAnswer(question, await loadDocs())
  if (fromDocs) return fromDocs

  // No intent and nothing in the docs matched — treat as off-topic and steer back to Nifra.
  return "I'm Nira, and I only answer questions about Nifra — the TypeScript framework. I can cover what Nifra is, its features, the typed client, runtimes, security, agents/MCP, or how to get started. What would you like to know?"
}

function appendMessage(role: MessageRole, text: string): HTMLParagraphElement | undefined {
  const messages = byId("nifra-bot-messages")
  if (!messages) return undefined
  const node = make("p", { className: `nifra-bot-message ${role}`, text: cleanText(text) })
  messages.append(node)
  while (messages.children.length > MAX_MESSAGES) {
    messages.removeChild(messages.children[1] ?? messages.firstElementChild ?? messages)
  }
  messages.scrollTop = messages.scrollHeight
  return node
}

function clampPosition(left: number, top: number): { left: number; top: number } {
  const container = byId("nifra-bot-container")
  if (!container) return { left, top }
  const margin = 14
  const rect = container.getBoundingClientRect()
  const width = rect.width || 100
  const height = rect.height || 100
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(72, top), Math.max(72, window.innerHeight - height - margin)),
  }
}

function setPosition(left: number, top: number, persist = true): void {
  const container = byId("nifra-bot-container")
  if (!container) return
  const next = clampPosition(left, top)
  container.style.left = `${Math.round(next.left)}px`
  container.style.top = `${Math.round(next.top)}px`
  container.style.right = "auto"
  container.style.bottom = "auto"
  if (persist) {
    try {
      sessionStorage.setItem(POSITION_KEY, JSON.stringify(next))
    } catch {
      // storage can fail in privacy modes
    }
  }
}

function currentPosition(): { left: number; top: number } {
  const rect = byId("nifra-bot-container")?.getBoundingClientRect()
  return rect ? { left: rect.left, top: rect.top } : { left: 0, top: 0 }
}

function restorePosition(): void {
  const container = byId("nifra-bot-container")
  if (!container) return
  let saved: { left: number; top: number } | undefined
  try {
    const raw = sessionStorage.getItem(POSITION_KEY)
    if (raw) saved = JSON.parse(raw) as { left: number; top: number }
  } catch {
    saved = undefined
  }
  const left = saved?.left ?? window.innerWidth - (container.offsetWidth || 110) - 22
  const top = saved?.top ?? window.innerHeight - (container.offsetHeight || 130) - 22
  setPosition(left, top, Boolean(saved))
}

function setOpen(open: boolean): void {
  const container = byId("nifra-bot-container")
  const panel = byId("nifra-bot-panel")
  const botButton = byId("nifra-bot")
  if (!container || !panel || !botButton) return
  container.dataset.open = open ? "true" : "false"
  panel.hidden = !open
  botButton.setAttribute("aria-expanded", open ? "true" : "false")
  byId("nifra-bubble")?.parentElement?.classList.toggle("visible", !open)
  if (!open) forceTip()
  requestAnimationFrame(() => {
    const pos = currentPosition()
    setPosition(pos.left, pos.top)
    if (open) byId<HTMLInputElement>("nifra-bot-input")?.focus()
  })
}

function showTip(text: string): void {
  const bubble = byId("nifra-bubble")
  if (!bubble) return
  const next = cleanText(text)
  bubble.parentElement?.classList.add("visible")
  if (bubble.textContent === next) return
  bubble.textContent = next
  // Retrigger the pop animation so a changed tip is noticeable as you scroll.
  bubble.classList.remove("pulse")
  void bubble.offsetWidth
  bubble.classList.add("pulse")
}

// --- Tip engine: purely IntersectionObserver-driven. The old version read
// getBoundingClientRect for every section + every `.prose h2` on EVERY scroll/wheel/touchmove
// frame — synchronous layout in the scroll path = jank. The observer instead reports crossings
// only when they happen, so scrolling does zero layout work here.
let homeEls: HTMLElement[] = []
let docEls: HTMLElement[] = []

// The element straddling (or nearest to) a target line ~28% down the viewport — the one being
// read. getBoundingClientRect here is fine: this runs ONLY on IntersectionObserver callbacks
// (a handful of times per scroll, at section boundaries), never on the scroll hot path.
const TARGET_FRACTION = 0.26 // the "reading line" — active section is the one crossing ~26% down

function nearestToTarget(els: readonly HTMLElement[]): HTMLElement | undefined {
  const target = window.innerHeight * TARGET_FRACTION
  let best: HTMLElement | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const el of els) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom < 80 || rect.top > window.innerHeight - 80) continue
    if (rect.top <= target && rect.bottom >= target) return el
    const distance = Math.abs(rect.top - target)
    if (distance < bestDistance) {
      best = el
      bestDistance = distance
    }
  }
  return best
}

function activeTip(): string | undefined {
  if (docEls.length > 0) {
    const title = nearestToTarget(docEls)?.textContent?.trim()
    if (title) return `Reading: ${title}`
  }
  const section = nearestToTarget(homeEls)
  if (section?.id) {
    lastSectionId = section.id
    return SECTION_TIPS[section.id]
  }
  return SECTION_TIPS[lastSectionId] ?? SECTION_TIPS.hero
}

function refreshTip(): void {
  if (byId("nifra-bot-container")?.dataset.open === "true") return
  const tip = activeTip()
  if (tip) showTip(tip)
}

// Scroll updates are rAF-coalesced AND gated to ≥12px of movement, so the rect reads in activeTip
// run only a handful of times per second during a scroll — never once per frame. That, plus the
// cached target arrays (no per-frame querySelectorAll) and the textContent dedupe in showTip, is
// what keeps scrolling smooth where the old per-frame recompute janked.
let tipFrame = 0
let lastTipScrollY = Number.NaN

function recomputeTip(): void {
  tipFrame = 0
  const y = window.scrollY
  if (Math.abs(y - lastTipScrollY) < 12) return
  lastTipScrollY = y
  refreshTip()
}

function scheduleTip(): void {
  if (tipFrame === 0) tipFrame = requestAnimationFrame(recomputeTip)
}

function forceTip(): void {
  lastTipScrollY = Number.NaN
  refreshTip()
}

function cacheTipTargets(): void {
  // Cache the homepage section elements + docs headings once per page load so the scroll path
  // never calls querySelectorAll (the original per-frame querySelectorAll was the jank source).
  homeEls = Object.keys(SECTION_TIPS)
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
  docEls = Array.from(document.querySelectorAll<HTMLElement>(".prose h2"))
}

function onSubmit(question: string): void {
  const trimmed = cleanText(question).slice(0, 180)
  if (!trimmed) return
  appendMessage("user", trimmed)
  const response = appendMessage("bot", "Thinking…")
  const settle = (answer: string): void => {
    if (response) {
      response.textContent = cleanText(answer)
      const messages = byId("nifra-bot-messages")
      if (messages) messages.scrollTop = messages.scrollHeight
    } else {
      appendMessage("bot", answer)
    }
  }
  // Always settle the placeholder, even if the docs lookup fails — never leave "Thinking…" stuck.
  void answerQuestion(trimmed)
    .then(settle)
    .catch(() =>
      settle(
        "I'm Nira — ask me about Nifra: what it is, its features, the typed client, runtimes, or how to get started.",
      ),
    )
}

function initBot(): void {
  ensureShell()
  const container = byId("nifra-bot-container")
  const panel = byId("nifra-bot-panel")
  if (!container || !panel) return
  container.style.display = "flex"
  container.dataset.open ||= "false"
  panel.hidden = container.dataset.open !== "true"
  restorePosition()
  cacheTipTargets()
  requestAnimationFrame(forceTip)
}

initBot()

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement
  if (target.closest("#nifra-bot")) {
    if (suppressNextClick) {
      suppressNextClick = false
      return
    }
    setOpen(byId("nifra-bot-container")?.dataset.open !== "true")
    return
  }
  if (target.closest("#nifra-bot-close")) {
    setOpen(false)
    return
  }
  if (target.closest("#nifra-bubble")) {
    setOpen(true)
    return
  }
  const quick = target.closest("[data-nifra-question]") as HTMLElement | null
  if (quick) {
    setOpen(true)
    onSubmit(quick.dataset.nifraQuestion ?? quick.textContent ?? "")
  }
})

document.addEventListener("submit", (event) => {
  if ((event.target as HTMLElement).id !== "nifra-bot-form") return
  event.preventDefault()
  const input = byId<HTMLInputElement>("nifra-bot-input")
  if (!input) return
  const value = input.value
  input.value = ""
  onSubmit(value)
})

document.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).id !== "nifra-bot-input") return
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
  event.preventDefault()
  byId<HTMLFormElement>("nifra-bot-form")?.requestSubmit()
})

document.addEventListener("pointerdown", (event) => {
  const bot = (event.target as HTMLElement).closest("#nifra-bot") as HTMLButtonElement | null
  if (!bot) return
  const pos = currentPosition()
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: pos.left,
    top: pos.top,
    moved: false,
  }
  byId("nifra-bot-container")?.classList.add("dragging")
  bot.setPointerCapture(event.pointerId)
})

document.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return
  const dx = event.clientX - drag.startX
  const dy = event.clientY - drag.startY
  if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true
  setPosition(drag.left + dx, drag.top + dy, false)
})

function endDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  const moved = drag.moved
  drag = undefined
  byId("nifra-bot-container")?.classList.remove("dragging")
  const pos = currentPosition()
  setPosition(pos.left, pos.top)
  if (moved) {
    suppressNextClick = true
    event.preventDefault()
  }
  forceTip()
}

document.addEventListener("pointerup", endDrag)
document.addEventListener("pointercancel", endDrag)
// Tip tracking: passive listeners feed a rAF-coalesced, movement-gated recompute (see scheduleTip),
// so the scroll path stays cheap. The container is position:fixed, so it never moves on scroll.
window.addEventListener("scroll", scheduleTip, { passive: true })
window.addEventListener("wheel", scheduleTip, { passive: true })
window.addEventListener("touchmove", scheduleTip, { passive: true })
let resizeFrame = 0
window.addEventListener(
  "resize",
  () => {
    if (resizeFrame !== 0) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      const pos = currentPosition()
      setPosition(pos.left, pos.top)
      forceTip()
    })
  },
  { passive: true },
)
