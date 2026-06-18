// A tiny, correct TS/JS highlighter. A char-by-char state machine (NOT regex) so keywords inside
// strings/comments are never mis-highlighted. Runs at SSR over dev-authored code strings only; the
// text is HTML-escaped and only our fixed <span> classes are emitted, so dangerouslySetInnerHTML is
// safe here (no user input ever reaches it).
const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "async",
  "await",
  "new",
  "interface",
  "type",
  "class",
  "extends",
  "implements",
  "if",
  "else",
  "for",
  "while",
  "of",
  "in",
  "typeof",
  "instanceof",
  "default",
  "void",
  "as",
  "public",
  "private",
  "readonly",
  "static",
  "enum",
  "namespace",
  "declare",
  "throw",
  "try",
  "catch",
  "finally",
  "switch",
  "case",
  "break",
  "continue",
]) // prettier-ignore

const LITERALS = new Set(["true", "false", "null", "undefined", "this"])

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function span(cls: string, text: string): string {
  return `<span class="${cls}">${esc(text)}</span>`
}
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isIdent = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

export function highlight(code: string): string {
  let out = ""
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i] as string
    const next = code[i + 1]
    if (c === "/" && next === "/") {
      let j = i + 2
      while (j < n && code[j] !== "\n") j++
      out += span("c", code.slice(i, j))
      i = j
    } else if (c === "/" && next === "*") {
      let j = i + 2
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++
      j = Math.min(n, j + 2)
      out += span("c", code.slice(i, j))
      i = j
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < n) {
        if (code[j] === "\\") {
          j += 2
          continue
        }
        if (code[j] === c) {
          j++
          break
        }
        j++
      }
      out += span("s", code.slice(i, j))
      i = j
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdent(code[j] as string)) j++
      const word = code.slice(i, j)
      out += KEYWORDS.has(word) ? span("k", word) : LITERALS.has(word) ? span("l", word) : esc(word)
      i = j
    } else {
      out += esc(c)
      i++
    }
  }
  return out
}

// `chrome` (default on) wraps the block in a mac-style window — dots + a language/filename tab —
// matching the docs code-windows so every code block reads the same. Pass `chrome={false}` for the
// compact inline snippets (e.g. ecosystem cards) that shouldn't carry a header bar.
export function CodeBlock({
  code,
  lang = "ts",
  filename,
  chrome = true,
}: {
  code: string
  lang?: string
  filename?: string
  chrome?: boolean
}) {
  const pre = (
    <pre className="code">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted dev-authored code, escaped */}
      <code dangerouslySetInnerHTML={{ __html: highlight(code) }} />
    </pre>
  )
  if (!chrome) return pre
  const label = filename ?? (lang === "sh" ? "Shell" : lang.toUpperCase())
  return (
    <div className="code-window">
      <div className="code-window-header">
        <div className="code-window-dots">
          <span className="code-window-dot red" />
          <span className="code-window-dot yellow" />
          <span className="code-window-dot green" />
        </div>
        <div className="code-window-lang">{label}</div>
      </div>
      {pre}
    </div>
  )
}
