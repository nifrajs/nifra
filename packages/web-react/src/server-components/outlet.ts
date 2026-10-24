import {
  type ComponentClientAdapter,
  ComponentController,
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
  const initial = useRef({
    __html: `<nifra-component data-nifra-component="${record.instance}">${record.html}</nifra-component>`,
  })
  const active = useRef<ComponentController | undefined>(undefined)
  const lifecycle = useRef(props)
  lifecycle.current = props
  useLayoutEffect(() => {
    const options = lifecycle.current
    const element = host.current?.firstElementChild
    if (!(element instanceof HTMLElement) || element.localName !== "nifra-component") return
    const controller =
      options.controller ??
      new ComponentController({
        state: options.state,
        adapter: options.clientAdapter ?? lazyClient(),
        onError: (code) => lifecycle.current.onError?.(code),
      })
    active.current = controller
    void controller
      .mount(element, record.instance)
      .catch(() => lifecycle.current.onError?.("component_failed"))
    return () => {
      // `<Activity>` hiding a kept page: its parked root stays until the page is shown or dropped.
      if (options.controller?.isParked(record.instance, element) === true) return
      void (
        options.controller === undefined
          ? controller.dispose()
          : controller.unmount(record.instance, element)
      ).catch(() => lifecycle.current.onError?.("component_failed"))
    }
  }, [record.instance])
  useLayoutEffect(() => {
    if (active.current !== undefined)
      void active.current.adopt(props.state).catch(() => props.onError?.("component_failed"))
  }, [props.state, props.onError])
  return createElement("nifra-component-outlet", {
    ref: host,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Record HTML passed the shared component policy before an outlet can resolve it.
    dangerouslySetInnerHTML: initial.current,
  })
}
