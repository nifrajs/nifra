import { holeComponents } from "@nifrajs/web/server-components/client"
import { reactComponentClient } from "@nifrajs/web-react/server-components/client"

// Before the router mounts: a hole's islands mount as soon as its host does.
holeComponents(reactComponentClient())
