/**
 * A Postgres tokenizer for the parser layer of `@nifrajs/mcp-db/postgres`. It refuses, before the
 * statement reaches the server, what it can see without the catalog: several statements, anything but a
 * query, row locks, and text it cannot read safely. It also names the functions a statement calls, which
 * the function allowlist then looks up in `pg_proc`; it decides nothing about them itself.
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

const READ_HEADS = new Set(["select", "with", "values", "table"])
const LOCKING_STRENGTHS = new Set(["update", "share", "no", "key"])

/** Why the parser layer refused a statement. */
export interface PgLintRefusal {
  readonly message: string
}

/**
 * Lint one statement: a single read-only query with balanced parentheses, no row-locking clause and
 * no unicode-escaped identifier. `undefined` when it passes.
 */
export function lintPostgres(sql: string): PgLintRefusal | undefined {
  const { tokens, unterminated, unicodeIdentifier } = lexPostgres(sql)
  if (unterminated) return { message: "the statement has an unterminated string or comment" }
  if (unicodeIdentifier)
    return { message: 'unicode-escaped identifiers (U&"...") are not accepted' }
  const terminator = tokens.findIndex((token) => token.kind === "punct" && token.value === ";")
  if (terminator !== -1 && tokens.slice(terminator + 1).length > 0) {
    return { message: "only a single statement is allowed" }
  }
  const body = terminator === -1 ? tokens : tokens.slice(0, terminator)
  const head = body.find((token) => !(token.kind === "punct" && token.value === "("))
  if (head === undefined) return { message: "empty query" }
  if (!head.bare || !READ_HEADS.has(head.value.toLowerCase())) {
    return {
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
      return { message: "row-locking clauses (FOR UPDATE, FOR SHARE) are refused: they take locks" }
    }
    if (token.value === "(" && token.kind === "punct") depth++
    else if (token.value === ")" && token.kind === "punct") {
      depth--
      if (depth < 0) return { message: "the statement closes a parenthesis it never opened" }
    }
  }
  if (depth !== 0) return { message: "the statement leaves a parenthesis open" }
  return undefined
}

// Postgres' reserved and type/function-name keywords: none of them can be a bare table name or alias.
const NOT_A_NAME = new Set(
  `
  all analyse analyze and any array as asc asymmetric both case cast check collate column
  constraint create current_catalog current_date current_role current_time current_timestamp
  current_user default deferrable desc distinct do else end except false fetch for foreign from
  grant group having in initially intersect into lateral leading limit localtime localtimestamp
  not null offset on only or order placing primary references returning select session_user some
  symmetric system_user table then to trailing true union unique user using variadic when where
  window with authorization binary collation concurrently cross current_schema freeze full ilike
  inner is isnull join left like natural notnull outer overlaps right similar tablesample verbose
  `
    .trim()
    .split(/\s+/),
)

// Words that close a FROM list at their own parenthesis depth.
const FROM_LIST_ENDS = new Set(
  `
  where group having window order limit offset fetch for union intersect except returning select
  `
    .trim()
    .split(/\s+/),
)

const isPunct = (token: PgToken | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value
const isKeyword = (token: PgToken | undefined, word: string): boolean =>
  token?.kind === "word" && token.bare && token.value.toLowerCase() === word
const isName = (token: PgToken | undefined): token is PgToken =>
  token?.kind === "word" && !(token.bare && NOT_A_NAME.has(token.value.toLowerCase()))

/** A table reference starting at `start` that carries a column alias list: `[ONLY] name [*] [AS] alias (`. */
function aliasListAt(
  tokens: readonly PgToken[],
  start: number,
): { readonly table: string; readonly alias: string } | undefined {
  let at = start
  const only = isKeyword(tokens[at], "only")
  if (only) at++
  const parenthesized = only && isPunct(tokens[at], "(")
  if (parenthesized) at++
  let name = tokens[at]
  if (!isName(name)) return undefined
  at++
  for (let part = tokens[at + 1]; isPunct(tokens[at], ".") && isName(part); part = tokens[at + 1]) {
    name = part
    at += 2
  }
  if (parenthesized) {
    if (!isPunct(tokens[at], ")")) return undefined
    at++
  } else if (isPunct(tokens[at], "(")) return undefined // a function in FROM, whose alias list is safe
  if (isPunct(tokens[at], "*")) at++
  if (isKeyword(tokens[at], "as")) at++
  const alias = tokens[at]
  if (!isName(alias) || !isPunct(tokens[at + 1], "(")) return undefined
  return { table: name.value, alias: alias.value }
}

/**
 * Every table the statement gives a column alias list, as in `FROM users AS t(a, b)`. A verbose plan
 * prints such a scan's columns by the alias names (its partitions' scans too), and the list can hand a
 * real column's name to another one, so no check on the plan's column names can see what is read.
 * A function's or a subquery's alias list is not reported: the plan prints the base columns under them.
 */
export function tableAliasLists(
  sql: string,
): readonly { readonly table: string; readonly alias: string }[] {
  const { tokens } = lexPostgres(sql)
  const found: { readonly table: string; readonly alias: string }[] = []
  // Per parenthesis depth: is a FROM list open there.
  const inFromList: boolean[] = [false]
  let itemStart = false
  for (const [index, token] of tokens.entries()) {
    const starts: boolean = itemStart
    itemStart = false
    if (starts) {
      const listed = aliasListAt(tokens, index)
      if (listed !== undefined) found.push(listed)
    }
    if (isPunct(token, "(")) {
      // A parenthesized join holds a FROM list of its own; a subquery's SELECT closes it.
      inFromList.push(starts)
      itemStart = starts
    } else if (isPunct(token, ")")) {
      if (inFromList.length > 1) inFromList.pop()
    } else if (isPunct(token, ",")) {
      itemStart = inFromList.at(-1) === true
    } else if (token.kind === "word" && token.bare) {
      const word = token.value.toLowerCase()
      if (word === "from" || word === "join") {
        inFromList[inFromList.length - 1] = true
        itemStart = true
      } else if (FROM_LIST_ENDS.has(word)) inFromList[inFromList.length - 1] = false
    }
  }
  return found
}

const NAME_BYTES = 63
const encoder = new TextEncoder()

/** An identifier as Postgres stores it: a bare word downcased (ASCII only), any name cut to 63 bytes. */
function identifier(token: PgToken): string {
  const value = token.bare
    ? token.value.replace(/[A-Z]+/g, (upper) => upper.toLowerCase())
    : token.value
  if (encoder.encode(value).byteLength <= NAME_BYTES) return value
  let cut = ""
  let bytes = 0
  for (const char of value) {
    bytes += encoder.encode(char).byteLength
    if (bytes > NAME_BYTES) break
    cut += char
  }
  return cut
}

/** A function a statement may call: the name before a `(`, with the schema that qualifies it. */
export interface PgCall {
  readonly schema: string | null
  readonly name: string
}

/**
 * Every `name(` and `schema.name(` in `sql`, named as the server resolves the identifiers. A keyword
 * or an alias list before a parenthesis is listed too; no function has its name, so a lookup drops it.
 */
export function functionCalls(sql: string): readonly PgCall[] {
  const { tokens } = lexPostgres(sql)
  const calls = new Map<string, PgCall>()
  for (const [index, token] of tokens.entries()) {
    const callee = tokens[index - 1]
    if (!isPunct(token, "(") || callee?.kind !== "word") continue
    const qualifier = isPunct(tokens[index - 2], ".") ? tokens[index - 3] : undefined
    const call = {
      schema: qualifier?.kind === "word" ? identifier(qualifier) : null,
      name: identifier(callee),
    }
    calls.set(JSON.stringify([call.schema, call.name]), call)
  }
  return [...calls.values()]
}

/** The statement without a final `;` (comments after it included), ready to wrap in a subquery. */
export function withoutTerminator(sql: string): string {
  const last = lexPostgres(sql).tokens.at(-1)
  return last?.kind === "punct" && last.value === ";" ? sql.slice(0, last.offset) : sql
}
