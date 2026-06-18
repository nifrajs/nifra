import { defineComponent, h } from "vue"

// Root layout — wraps every page via its default slot (compose passes the child there); the nav
// proves the layout renders + client nav works on Vue. Render function (h), no JSX/SFC compiler.
export default defineComponent({
  name: "Layout",
  setup(_props, { slots }) {
    return () =>
      h("div", null, [
        h("nav", { id: "nav" }, [
          h("a", { href: "/" }, "home"),
          " · ",
          h("a", { href: "/todos" }, "todos"),
        ]),
        slots.default?.(),
      ])
  },
})
