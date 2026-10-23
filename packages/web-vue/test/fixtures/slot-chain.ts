import { defineComponent, h, KeepAlive, ref, Transition } from "vue"

const page = (name: string) =>
  defineComponent({
    name,
    props: ["data", "actionData", "pending", "layoutData", "boundaries"],
    setup(props) {
      const count = ref(0)
      return () =>
        h(
          "button",
          { id: "counter", onClick: () => count.value++ },
          `${name}:${count.value}${props.data === null ? "" : `:${props.data}`}`,
        )
    },
  })
export const A = page("A")
export const B = page("B")
export const KeepAliveLayout = defineComponent({
  props: ["data", "boundaries"],
  setup(_props, { slots }) {
    return () =>
      h("main", null, h(KeepAlive, { include: "A,B" }, { default: () => slots.default?.() }))
  },
})

export const TransitionLayout = defineComponent({
  props: ["data", "boundaries"],
  setup(_props, { slots }) {
    return () =>
      h(
        "main",
        null,
        h(
          Transition,
          {
            mode: "out-in",
            css: false,
            onLeave: (_element: Element, done: () => void) =>
              Reflect.set(globalThis, "leaveDone", done),
          },
          { default: () => slots.default?.() },
        ),
      )
  },
})

export const RepeatedLayout = defineComponent({
  props: ["data", "boundaries"],
  setup(_props, { slots }) {
    return () => h("main", null, [slots.default?.(), slots.default?.()])
  },
})

// Two nested layouts that count their renders, for the render-skipping test.
const renders: Record<string, number> = {}
Reflect.set(globalThis, "renders", renders)
const counted = (name: string) =>
  defineComponent({
    name,
    props: ["data", "boundaries"],
    setup(_props, { slots }) {
      const count = ref(0)
      return () => {
        renders[name] = (renders[name] ?? 0) + 1
        return h("section", null, [
          h("button", { class: name, onClick: () => count.value++ }, `${name}:${count.value}`),
          slots.default?.(),
        ])
      }
    },
  })
export const Outer = counted("Outer")
export const Inner = counted("Inner")

// Counts its renders in `layoutRenders`; `layoutTick()` re-renders it on its own.
export const CountingLayout = defineComponent({
  props: ["data", "boundaries"],
  setup(_props, { slots }) {
    const tick = ref(0)
    Reflect.set(globalThis, "layoutTick", () => tick.value++)
    return () => {
      Reflect.set(
        globalThis,
        "layoutRenders",
        Number(Reflect.get(globalThis, "layoutRenders") ?? 0) + 1,
      )
      return h("main", { "data-tick": tick.value }, slots.default?.())
    }
  },
})
