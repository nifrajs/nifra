/** Marks a coercing `validate`. On the function, not the schema, so a spread copy keeps it. */
export const COERCES = Symbol.for("nifra.schema.coerce")

/**
 * On a `validate` that does not coerce: the coercing form of the same schema. Core takes it for a
 * route's `query`, `headers` and `cookies`, whose values always arrive as text, so a `t.object` there
 * reads `?flag=true` as `true` the way `t.query` does, and core ships no conversion code.
 */
export const TEXT_SLOT = Symbol.for("nifra.schema.textSlot")
