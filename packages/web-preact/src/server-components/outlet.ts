import {
  type ComponentClientAdapter,
  ComponentController,
  type ServerComponent as ComponentHandle,
  type ComponentKey,
  type ComponentState,
  resolveComponentRecord,
} from "@nifrajs/web/server-components/client"
import { h } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"

export interface ServerComponentProps<Input, Props, View> {
  readonly state: ComponentState
  readonly component: ComponentHandle<Input, Props, View>
  readonly instanceKey: ComponentKey
  readonly input: NoInfer<Input>
  readonly parent?: string
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter | undefined
  readonly onError?: ((code: string) => void) | undefined
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
  return h(ComponentRange, {
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
  // Preact owns the shell while the controller owns its independently hydrated native children.
  const initial = useRef({
    __html: `<nifra-component data-nifra-component="${record.instance}">${record.html}</nifra-component>`,
  })
  const active = useRef<ComponentController | undefined>(undefined)
  const lifecycle = useRef(props)
  lifecycle.current = props
  useLayoutEffect(() => {
    const options = lifecycle.current
    if (options.controller === undefined && options.clientAdapter === undefined)
      throw new Error("component_contract")
    const element = host.current?.firstElementChild
    if (!(element instanceof HTMLElement) || element.localName !== "nifra-component")
      throw new Error("component_contract")
    const controller =
      options.controller ??
      new ComponentController({
        state: options.state,
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The effect rejects missing adapters before creating a controller; callers with a controller bypass this expression.
        adapter: options.clientAdapter as ComponentClientAdapter,
        onError: (code) => lifecycle.current.onError?.(code),
      })
    active.current = controller
    void controller
      .mount(element, record.instance)
      .catch(() => controller.reportError("component_failed"))
    return () => {
      void (
        options.controller === undefined
          ? controller.dispose()
          : controller.unmount(record.instance)
      ).catch(() => controller.reportError("component_failed"))
    }
  }, [record.instance])
  useLayoutEffect(() => {
    if (active.current !== undefined)
      void active.current
        .adopt(props.state)
        .catch(() => active.current?.reportError("component_failed"))
  }, [props.state])
  return h("nifra-component-outlet", {
    ref: host,
    // Record HTML passed the shared component policy before an outlet can resolve it.
    dangerouslySetInnerHTML: initial.current,
  })
}
