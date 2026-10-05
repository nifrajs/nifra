/** A hook read a null dispatcher: the component's React is not the one the renderer set up. JSC and V8
 * word the null dereference differently; the property read is always a hook. */
const NO_DISPATCHER =
  /ReactSharedInternals\.H\.|resolveDispatcher\(\)\.|Cannot read properties of null \(reading 'use[A-Za-z]*'\)/

/** Name the cause of a null-dispatcher crash. The app-root check in ./react-dom-server catches a
 * renderer on the wrong copy; this covers a component that brings its own (a linked package's). */
export function explainRenderError(error: unknown): unknown {
  if (!(error instanceof TypeError) || !NO_DISPATCHER.test(error.message)) return error
  return new Error(
    "[nifra/web-react] a component called a React hook with no dispatcher, so two copies of React " +
      "reached SSR: the one react-dom renders with, and another the component imports (often a linked " +
      "package's own node_modules). Dedupe react to one physical copy: `nifra check` names the " +
      "importer of each, and the package.json `nifra.singleCopy` declaration redirects them. " +
      `See https://nifra.dev/docs/troubleshooting. (${error.message})`,
    { cause: error },
  )
}
