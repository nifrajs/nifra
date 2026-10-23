import {
  type ComponentClientAdapter,
  ComponentController,
  type ComponentKey,
  type ComponentState,
  type ServerComponent as Handle,
  resolveComponentRecord,
  type ServerComponentHandle,
} from "@nifrajs/web/server-components/client"
import {
  computed,
  defineComponent,
  type FunctionalComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  type VNode,
  watch,
} from "vue"
export interface ServerComponentProps<Input, Props, View> {
  readonly state: ComponentState
  readonly component: Handle<Input, Props, View>
  readonly instanceKey: ComponentKey
  readonly input: NoInfer<Input>
  readonly parent?: string
  readonly controller?: ComponentController
  readonly clientAdapter?: ComponentClientAdapter
}
export function ServerComponent<Input, Props, View>(
  props: ServerComponentProps<Input, Props, View>,
): VNode {
  return h(ComponentOutlet, { ...props })
}
/** Specialize the schema before Vue's h/template component-prop inference. */
export function createServerComponentOutlet<Input, Props, View>(
  component: Handle<Input, Props, View>,
): FunctionalComponent<Omit<ServerComponentProps<Input, Props, View>, "component">> {
  return (props) => ServerComponent({ ...props, component })
}
const ComponentOutlet = defineComponent({
  props: {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue PropType annotates its native constructor ABI; outlet records are resolved through the closed state parser.
    state: { type: Object as PropType<ComponentState>, required: true },
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue PropType annotates its native constructor ABI; outlet records are resolved through the closed state parser.
    component: { type: Object as PropType<ServerComponentHandle>, required: true },
    instanceKey: { type: [String, Number], required: true },
    input: { type: null, required: true },
    parent: String,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue PropType annotates its native constructor ABI; outlet records are resolved through the closed state parser.
    controller: Object as PropType<ComponentController>,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue PropType annotates its native constructor ABI; outlet records are resolved through the closed state parser.
    clientAdapter: Object as PropType<ComponentClientAdapter>,
  },
  setup(props) {
    const record = computed(() =>
      resolveComponentRecord(
        props.state,
        props.component,
        props.instanceKey,
        props.input,
        props.parent ?? null,
      ),
    )
    let mounted = record.value
    const initial = mounted.html
    let host: Element | null = null
    let controller: ComponentController | undefined
    onMounted(() => {
      if (props.controller === undefined && props.clientAdapter === undefined)
        throw new Error("component_contract")
      controller =
        props.controller ??
        new ComponentController({ state: props.state, adapter: props.clientAdapter! })
      if (host !== null)
        void controller
          .mount(host, mounted.instance)
          .catch(() => controller?.reportError("component_failed"))
    })
    watch(
      () => props.state,
      async (state) => {
        if (controller === undefined || host === null) return
        if (mounted.instance !== record.value.instance) {
          await controller.unmount(mounted.instance)
          mounted = record.value
          await controller.adopt(state)
          await controller.mount(host, mounted.instance, true)
        } else await controller.adopt(state)
      },
      { flush: "post" },
    )
    onBeforeUnmount(() => {
      if (controller !== undefined)
        void (props.controller === undefined
          ? controller.dispose()
          : controller.unmount(mounted.instance, host ?? undefined))
    })
    return () =>
      h("nifra-component", {
        ref: (value: unknown) => {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue PropType annotates its native constructor ABI; outlet records are resolved through the closed state parser.
          host = value as Element | null
        },
        "data-nifra-component": record.value.instance,
        innerHTML: initial,
      })
  },
})
