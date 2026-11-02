import { type MountedOutlet, mountOutlet, outletHtml } from "@nifrajs/web/internal/component-outlet"
import {
  type ComponentClientAdapter,
  type ComponentController,
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
  const initial = useRef(outletHtml(record))
  const mounted = useRef<MountedOutlet | undefined>(undefined)
  const lifecycle = useRef(props)
  lifecycle.current = props
  useLayoutEffect(() => {
    const outlet = mountOutlet(lifecycle, host.current?.firstElementChild, record.instance)
    mounted.current = outlet
    return outlet?.teardown
  }, [record.instance])
  useLayoutEffect(() => {
    mounted.current?.adopt(props.state)
  }, [props.state])
  return h("nifra-component-outlet", {
    ref: host,
    // Record HTML passed the shared component policy before an outlet can resolve it.
    dangerouslySetInnerHTML: initial.current,
  })
}
