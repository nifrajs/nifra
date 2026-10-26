import {
  type MountedOutlet,
  mountOutlet,
  type OutletFramework,
  outletHtml,
} from "@nifrajs/web/internal/component-outlet"
import {
  type ComponentClientAdapter,
  type ComponentController,
  type ServerComponent as ComponentHandle,
  type ComponentKey,
  type ComponentState,
  resolveComponentRecord,
} from "@nifrajs/web/server-components/client"
import { createElement, useLayoutEffect, useRef } from "react"

declare const __NIFRA_COMPONENT_BROWSER__: boolean
function lazyClient(): ComponentClientAdapter {
  let pending: Promise<ComponentClientAdapter> | undefined
  const client = () => {
    if (typeof __NIFRA_COMPONENT_BROWSER__ === "boolean" && !__NIFRA_COMPONENT_BROWSER__)
      throw new Error("component_contract")
    pending ??= import("./client.ts").then((module) => module.reactComponentClient())
    return pending
  }
  return {
    name: "react",
    prepare: async (...args) => (await client()).prepare(...args),
    hydrate: async (...args) => (await client()).hydrate(...args),
    create: async (...args) => {
      const create = (await client()).create
      if (create === undefined) throw new Error("component_contract")
      return create(...args)
    },
    update: async (...args) => (await client()).update(...args),
  }
}
const REACT_OUTLET: OutletFramework = { clientAdapter: lazyClient, hidingCleansUp: true }

export interface ServerComponentProps<Input, Props, View> {
  readonly state: ComponentState
  readonly component: ComponentHandle<Input, Props, View>
  readonly instanceKey: ComponentKey
  readonly input: NoInfer<Input>
  readonly parent?: string
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter
  readonly onError?: (code: string) => void
}
export function ServerComponent<Input, Props, View>(
  props: ServerComponentProps<Input, Props, View>,
) {
  const record = resolveComponentRecord(
    props.state,
    props.component,
    props.instanceKey,
    props.input,
    props.parent ?? null,
  )
  return createElement(ComponentRange, {
    key: record.instance,
    state: props.state,
    record,
    controller: props.controller,
    clientAdapter: props.clientAdapter,
    onError: props.onError,
  })
}
function ComponentRange(props: {
  readonly state: ComponentState
  readonly record: import("@nifrajs/web/server-components/client").ComponentRecord
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter | undefined
  readonly onError?: ((code: string) => void) | undefined
}) {
  const record = props.record
  const host = useRef<HTMLElement>(null)
  // React owns the shell; the independently hydrated native root is an unassociated child.
  const initial = useRef(outletHtml(record))
  const mounted = useRef<MountedOutlet | undefined>(undefined)
  const lifecycle = useRef(props)
  lifecycle.current = props
  useLayoutEffect(() => {
    const outlet = mountOutlet(
      lifecycle,
      host.current?.firstElementChild,
      record.instance,
      REACT_OUTLET,
    )
    mounted.current = outlet
    return outlet?.teardown
  }, [record.instance])
  useLayoutEffect(() => {
    mounted.current?.adopt(props.state)
  }, [props.state])
  return createElement("nifra-component-outlet", {
    ref: host,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Record HTML passed the shared component policy before an outlet can resolve it.
    dangerouslySetInnerHTML: initial.current,
  })
}
