/**
 * Compatibility package for applications that adopted `@nifrajs/budget` before the deadline
 * primitive moved to its natural owner. New code may import the same Interface from
 * `@nifrajs/core/budget`; both paths resolve to one implementation and one set of nominal classes.
 */
export * from "@nifrajs/core/budget"
