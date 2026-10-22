/**
 * Experimental: a partially prerendered hole whose content is a server component. The hole's loader
 * returns the component's input; the server runs the component for each visitor and sends its HTML,
 * and the browser mounts only the client islands inside it. Under the coordinated compiler a browser
 * import of a `*.component.server` module is an opaque handle, so the component never ships.
 */
import type { ServerComponent } from "./types.ts"

const COMPONENT = Symbol.for("nifra.web.server-hole")

/**
 * A `dynamic` hole's `render`: the hole shows `component`, given the hole loader's output as its
 * input. The page's app lists the component under `createServerComponents({ holes })` for the route.
 * The hole cannot be `interactive`; its client islands are.
 */
export function serverHole<Input, Props, View>(
  component: ServerComponent<Input, Props, View>,
): (data: Input) => never {
  const render = (): never => {
    throw new Error("[nifra/web] a server component hole renders on the server only")
  }
  Object.defineProperty(render, COMPONENT, { value: component })
  return Object.freeze(render)
}

/** The server component a hole's `render` names, or `undefined` for an ordinary `render`. */
export const serverHoleComponent = (render: unknown): object | undefined => {
  if (typeof render !== "function") return undefined
  const component: unknown = Reflect.get(render, COMPONENT)
  return typeof component === "object" && component !== null ? component : undefined
}
