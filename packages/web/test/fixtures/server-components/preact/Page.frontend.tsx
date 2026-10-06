import type {
  ComponentClientAdapter,
  ComponentController,
  ComponentState,
} from "@nifrajs/web/server-components/client"
import { ServerComponent } from "@nifrajs/web-preact/server-components/outlet"
import { useState } from "preact/hooks"
import { Summary } from "./Summary.component.server"
export default function Page(props: {
  state: ComponentState
  controller?: ComponentController | undefined
  clientAdapter?: ComponentClientAdapter | undefined
}) {
  const [count, setCount] = useState(0)
  return (
    <main>
      <button type="button" id="parent-counter" onClick={() => setCount(count + 1)}>
        Parent {count}
      </button>
      <ServerComponent
        state={props.state}
        controller={props.controller}
        clientAdapter={props.clientAdapter}
        component={Summary}
        instanceKey="summary"
        input={{}}
      />
    </main>
  )
}
