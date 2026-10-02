/**
 * A Postgres tokenizer for the parser layer of `@nifrajs/mcp-db/postgres`. It is the SECOND layer: the
 * server already refuses several statements (extended protocol), anything but a query (the cursor),
 * and writes (the read-only transaction). This layer adds what the server allows but a dev agent must
 * not do: call a function that reaches outside the query (server files, locks, other sessions,
 * settings, notifications, another database), or one that runs SQL from a string where the plan check
 * cannot see it (`query_to_xml`).
 *
 * The lexer follows Postgres with `standard_conforming_strings = on`, which the engine sets on every
 * connection so the server reads string boundaries exactly as this lexer does.
 */

/** One lexical unit. Strings, comments and dollar-quoted bodies produce nothing. */
export interface PgToken {
  readonly kind: "word" | "punct" | "number" | "param"
  /** Identifier text (quotes removed, `""` collapsed) or the punctuation character. */
  readonly value: string
  /** An unquoted word - the only kind that can be a keyword. */
  readonly bare: boolean
  /** Where the token starts in the source. */
  readonly offset: number
}

export interface PgLexResult {
  readonly tokens: readonly PgToken[]
  /** A string, quoted identifier, comment or dollar-quoted body never closed. */
  readonly unterminated: boolean
  /** A `U&"..."` identifier: its escapes can spell any name, so it is refused outright. */
  readonly unicodeIdentifier: boolean
}

const WORD_START = /[A-Za-z_\u0080-￿]/
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/

/** Tokenize Postgres SQL far enough to see statements, parentheses and function calls. */
export function lexPostgres(sql: string): PgLexResult {
  const tokens: PgToken[] = []
  let unterminated = false
  let unicodeIdentifier = false
  let i = 0
  const skipString = (escapes: boolean): void => {
    i++ // past the opening quote
    while (i < sql.length) {
      const char = sql[i]
      if (escapes && char === "\\") {
        i += 2
        continue
      }
      if (char === "'") {
        if (sql[i + 1] === "'") {
          i += 2
          continue
        }
        i++
        return
      }
      i++
    }
    unterminated = true
  }
  while (i < sql.length) {
    const char = sql.charAt(i)
    const next = sql[i + 1]
    if (/\s/.test(char)) {
      i++
    } else if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i)
      i = end === -1 ? sql.length : end + 1
    } else if (char === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++
          i += 2
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--
          i += 2
        } else i++
      }
      if (depth > 0) unterminated = true
    } else if (char === "'") {
      skipString(false)
    } else if ((char === "E" || char === "e") && next === "'") {
      i++
      skipString(true)
    } else if ((char === "U" || char === "u") && next === "&" && sql[i + 2] === "'") {
      i += 2
      skipString(false)
    } else if ((char === "U" || char === "u") && next === "&" && sql[i + 2] === '"') {
      unicodeIdentifier = true
      i += 2
    } else if (
      (char === "B" ||
        char === "b" ||
        char === "X" ||
        char === "x" ||
        char === "N" ||
        char === "n") &&
      next === "'"
    ) {
      i++
      skipString(false)
    } else if (char === '"') {
      const offset = i
      let value = ""
      let closed = false
      i++
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"'
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        value += sql[i]
        i++
      }
      if (!closed) unterminated = true
      tokens.push({ kind: "word", value, bare: false, offset })
    } else if (char === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0]
      if (tag !== undefined) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) {
          unterminated = true
          i = sql.length
        } else i = end + tag.length
      } else if (next !== undefined && next >= "0" && next <= "9") {
        const start = i
        i++
        while (i < sql.length && /[0-9]/.test(sql.charAt(i))) i++
        tokens.push({ kind: "param", value: sql.slice(start, i), bare: false, offset: start })
      } else {
        tokens.push({ kind: "punct", value: char, bare: false, offset: i })
        i++
      }
    } else if (WORD_START.test(char)) {
      const start = i
      while (i < sql.length && WORD_PART.test(sql.charAt(i))) i++
      tokens.push({ kind: "word", value: sql.slice(start, i), bare: true, offset: start })
    } else if (
      (char >= "0" && char <= "9") ||
      (char === "." && next !== undefined && /[0-9]/.test(next))
    ) {
      // Digits only: a letter right after a number starts a new word, so `1pg_sleep(` still shows
      // the call (older servers lex it the same way).
      const start = i
      while (i < sql.length && /[0-9_.]/.test(sql.charAt(i))) i++
      if ((sql[i] === "e" || sql[i] === "E") && /[0-9+-]/.test(sql[i + 1] ?? "")) {
        i += 2
        while (i < sql.length && /[0-9]/.test(sql.charAt(i))) i++
      }
      tokens.push({ kind: "number", value: sql.slice(start, i), bare: false, offset: start })
    } else {
      tokens.push({ kind: "punct", value: char, bare: false, offset: i })
      i++
    }
  }
  return { tokens, unterminated, unicodeIdentifier }
}

/**
 * Function-name prefixes the parser layer refuses. Each reaches outside a read-only query or runs SQL
 * from a string the plan check cannot see; the server lets a read-only transaction call most of them.
 */
export const DENIED_FUNCTION_PREFIXES: readonly string[] = [
  "dblink",
  "lo_",
  "pg_read_",
  "pg_ls_",
  "pg_stat_file",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "set_config",
  "pg_advisory",
  "pg_try_advisory",
  "pg_notify",
  "query_to_xml",
  "table_to_xml",
  "cursor_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "pg_file_",
  "pg_logical_emit_message",
  "pg_stat_reset",
  "pg_stat_get_",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_promote",
  "pg_rotate_logfile",
  "nextval",
  "setval",
]

const READ_HEADS = new Set(["select", "with", "values", "table"])
const LOCKING_STRENGTHS = new Set(["update", "share", "no", "key"])

/** Why the parser layer refused a statement. */
export type PgLintRefusal =
  | { readonly kind: "statement"; readonly message: string }
  | { readonly kind: "function"; readonly message: string; readonly name: string }

/**
 * Lint one statement: a single read-only query with balanced parentheses, no unicode-escaped
 * identifier and no denied function call. `undefined` when it passes.
 */
export function lintPostgres(sql: string): PgLintRefusal | undefined {
  const { tokens, unterminated, unicodeIdentifier } = lexPostgres(sql)
  if (unterminated) {
    return { kind: "statement", message: "the statement has an unterminated string or comment" }
  }
  if (unicodeIdentifier) {
    return { kind: "statement", message: 'unicode-escaped identifiers (U&"...") are not accepted' }
  }
  const terminator = tokens.findIndex((token) => token.kind === "punct" && token.value === ";")
  if (terminator !== -1 && tokens.slice(terminator + 1).length > 0) {
    return { kind: "statement", message: "only a single statement is allowed" }
  }
  const body = terminator === -1 ? tokens : tokens.slice(0, terminator)
  const head = body.find((token) => !(token.kind === "punct" && token.value === "("))
  if (head === undefined) return { kind: "statement", message: "empty query" }
  if (!head.bare || !READ_HEADS.has(head.value.toLowerCase())) {
    return {
      kind: "statement",
      message: `only a read-only query (SELECT, WITH, VALUES or TABLE) is allowed, not ${head.value.toUpperCase()}`,
    }
  }
  let depth = 0
  for (const [index, token] of body.entries()) {
    if (token.kind !== "punct" && token.kind !== "word") continue
    const next = body[index + 1]
    if (
      token.bare &&
      token.value.toLowerCase() === "for" &&
      next?.bare === true &&
      LOCKING_STRENGTHS.has(next.value.toLowerCase())
    ) {
      return {
        kind: "statement",
        message: "row-locking clauses (FOR UPDATE, FOR SHARE) are refused: they take locks",
      }
    }
    if (token.value === "(" && token.kind === "punct") {
      depth++
      const callee = body[index - 1]
      if (callee?.kind === "word") {
        const name = callee.value.toLowerCase()
        if (DENIED_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))) {
          return {
            kind: "function",
            name,
            message: `${name}() is refused: it reaches outside a read-only query`,
          }
        }
      }
    } else if (token.value === ")" && token.kind === "punct") {
      depth--
      if (depth < 0) {
        return { kind: "statement", message: "the statement closes a parenthesis it never opened" }
      }
    }
  }
  if (depth !== 0) return { kind: "statement", message: "the statement leaves a parenthesis open" }
  return undefined
}

/** The statement without a final `;` (comments after it included), ready to wrap in a subquery. */
export function withoutTerminator(sql: string): string {
  const last = lexPostgres(sql).tokens.at(-1)
  return last?.kind === "punct" && last.value === ";" ? sql.slice(0, last.offset) : sql
}
