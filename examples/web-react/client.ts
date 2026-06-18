import { DATA_GLOBAL } from "@nifrajs/web"
import { hydrate } from "@nifrajs/web-react/client"
import { App } from "./app.tsx"
import Layout from "./layout.tsx"

const data = (globalThis as Record<string, unknown>)[DATA_GLOBAL]
const root = document.getElementById("root")
if (root) hydrate([Layout, App], { data }, root)
