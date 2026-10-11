import {
  type ComponentClientAdapter,
  ComponentController,
  type ComponentKey,
  type ComponentState,
  type ServerComponent as Handle,
  resolveComponentRecord,
} from "@nifrajs/web/server-components/client"
import { createEffect, createMemo, type JSX, onCleanup, onMount, Show } from "solid-js"
export function ServerComponent<Input, Props, View>(props: {
  readonly state: ComponentState
  readonly component: Handle<Input, Props, View>
  readonly instanceKey: ComponentKey
  readonly input: NoInfer<Input>
  readonly parent?: string
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter | undefined
}): JSX.Element {
  const record = createMemo(() =>
    resolveComponentRecord(
      props.state,
      props.component,
      props.instanceKey,
      props.input,
      props.parent ?? null,
    ),
  )
  return (
    <Show keyed when={record().instance}>
      {(_instance: string) => (
        <Range
          state={props.state}
          record={record()}
          controller={props.controller}
          clientAdapter={props.clientAdapter}
        />
      )}
    </Show>
  )
}
function Range(props: {
  readonly state: ComponentState
  readonly record: import("@nifrajs/web/server-components/client").ComponentRecord
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter | undefined
}): JSX.Element {
  const record = props.record
  let host!: HTMLDivElement
  let controller: ComponentController | undefined
  onMount(() => {
    if (props.controller === undefined && props.clientAdapter === undefined)
      throw new Error("component_contract")
    controller =
      props.controller ??
      new ComponentController({ state: props.state, adapter: props.clientAdapter! })
    void controller.mount(host, record.instance).catch(() => {
      throw new Error("component_failed")
    })
  })
  onCleanup(() => {
    if (controller !== undefined)
      void (props.controller === undefined
        ? controller.dispose()
        : controller.unmount(record.instance))
  })
  createEffect(() => {
    const state = props.state
    if (controller !== undefined)
      void controller.adopt(state).catch(() => controller?.reportError("component_failed"))
  })
  return <div ref={host} data-nifra-component={record.instance} innerHTML={record.html} />
}
