import { DATA_GLOBAL } from "@nifrajs/web"
import { hydrate } from "@nifrajs/web-svelte/client"
import App from "./App.svelte"
import Layout from "./Layout.svelte"

const data = (globalThis as Record<string, unknown>)[DATA_GLOBAL]
const root = document.getElementById("root")
if (root) hydrate([Layout, App], { data }, root)
