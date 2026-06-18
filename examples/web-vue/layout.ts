import { defineComponent, h } from "vue"

// Root layout — wraps the page via its default slot (the compose fold passes the child there).
export const Layout = defineComponent({
  setup:
    (_props, { slots }) =>
    () =>
      h("div", { class: "wrap" }, slots.default?.()),
})
