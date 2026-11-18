import { createMemo } from "solid-js"

/**
 * The memos behind the route props exist only in the browser. Solid 2 gives each memo a hydration id
 * slot, so one the server never created would shift every key after it; `transparent` takes none.
 */
export const clientDerive = <T>(read: () => T): (() => T) => createMemo(read, { transparent: true })
