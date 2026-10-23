import { holeComponents } from "@nifrajs/web/server-components/client"
import { vueComponentClient } from "@nifrajs/web-vue/server-components/client"
import { counter } from "./Counter.island.ts"

// Before the router mounts: a hole's islands mount as soon as its host does.
holeComponents(vueComponentClient({ islands: [counter] }))
