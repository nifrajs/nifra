import { DATA_GLOBAL } from "@nifrajs/web"
import { hydrate } from "@nifrajs/web-preact/client"
import { App } from "./app.ts"
import { Layout } from "./layout.ts"

const data = (globalThis as Record<string, unknown>)[DATA_GLOBAL]
const root = document.getElementById("root")
if (root) hydrate([Layout, App], { data }, root)
