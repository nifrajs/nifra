/**
 * A value a step may use but the model must never read: it is typed into the page by name, and
 * `String(secret)`, `JSON.stringify(secret)` and template literals all print the name only.
 */
export class Secret {
  readonly name: string
  readonly #value: string

  constructor(name: string, value: string) {
    this.name = name
    this.#value = value
  }

  /** Read by the step runner when it types the value; nothing else should call it. */
  static reveal(secret: Secret): string {
    return secret.#value
  }

  toJSON(): string {
    return `[secret:${this.name}]`
  }

  toString(): string {
    return `[secret:${this.name}]`
  }
}

/**
 * Run-varying data (a generated email, a timestamp). The model and the page get the value; the replay
 * cache keys on the fact that it varies, so a new value does not miss, and re-types the new value.
 */
export class Unique {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }

  toString(): string {
    return this.value
  }
}

export function unique(value: string | number): Unique {
  return new Unique(String(value))
}

export type Param = string | number | boolean | Secret | Unique
export type Params = Readonly<Record<string, Param>>

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `{name}` becomes the param's value, except a secret, which stays `{name}` and is listed by name. */
export function forModel(
  text: string,
  params: Params,
): { readonly text: string; readonly secrets: readonly string[] } {
  const secrets = new Set<string>()
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const param = params[name]
    if (param === undefined) return whole
    if (param instanceof Secret) {
      secrets.add(name)
      return whole
    }
    return String(param)
  })
  return { text: out, secrets: [...secrets] }
}

/** `{name}` becomes the real value, a secret's included. Run only on text headed for the page. */
export function forPage(text: string, params: Params): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const param = params[name]
    if (param === undefined) return whole
    return param instanceof Secret ? Secret.reveal(param) : String(param)
  })
}

/** A secret and the name it was given, which is the placeholder that stands in for its value. */
export type NamedSecret = readonly [name: string, secret: Secret]

/** Every secret value in `text` replaced by its placeholder, so a page that echoes one cannot leak it. */
export function redactSecrets(text: string, secrets: readonly NamedSecret[]): string {
  let out = text
  for (const [name, secret] of secrets) {
    const value = Secret.reveal(secret)
    if (value !== "") out = out.split(value).join(`{${name}}`)
  }
  return out
}

export function redact(text: string, params: Params): string {
  const secrets: NamedSecret[] = []
  for (const [name, param] of Object.entries(params)) {
    if (param instanceof Secret) secrets.push([name, param])
  }
  return redactSecrets(text, secrets)
}

/** The params as a replay-cache key sees them: plain values by value, a secret or a unique by kind. */
export function keyParams(params: Params): string {
  const entries = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, param]) => [
      name,
      param instanceof Secret ? "<secret>" : param instanceof Unique ? "<unique>" : String(param),
    ])
  return JSON.stringify(entries)
}

/** Every unique value found literally in `text` turned back into its `{name}`, so a recording survives a new value. */
export function templatize(text: string, params: Params): string {
  let out = text
  for (const [name, param] of Object.entries(params)) {
    if (param instanceof Unique && param.value !== "")
      out = out.split(param.value).join(`{${name}}`)
  }
  return out
}

/** `{name}` becomes the current value of a unique param; any other placeholder stays. */
export function fillUnique(text: string, params: Params): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const param = params[name]
    return param instanceof Unique ? param.value : whole
  })
}
