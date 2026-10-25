import type { RenderProps } from "@nifrajs/web"

// Every route prop with a value: a field `RenderProps` gains fails typecheck here until it has one.
export const EVERY_ROUTE_PROP: Required<RenderProps> = {
  serverComponents: {
    v: 1,
    build: "build",
    adapter: "vue",
    owner: "owner",
    scope: "anonymous",
    records: [],
  },
  data: { page: 1 },
  layoutData: [{ layout: 1 }],
  actionData: { saved: true },
  pending: true,
  pendingPath: "/items/2",
  submission: { action: "/items/1", formData: new FormData() },
  params: { id: "1" },
  path: "/items/1?tab=a",
  search: { tab: "a" },
  boundaries: { photo: { name: "photo", mode: "static", status: "ready", data: { src: "p" } } },
  matchChain: { ids: ["items/[id]"], handles: [undefined] },
  locale: { key: "en", lang: "en", dir: "ltr" },
}

export const ROUTE_PROP_NAMES: readonly string[] = Object.keys(EVERY_ROUTE_PROP)
