import { ServerComponent } from "@nifrajs/web-react/server-components/outlet"
import { useState } from "react"
import { Summary } from "../Summary.component.server"
export default function Page(props: {
  state: import("@nifrajs/web/server-components/client").ComponentState
  controller?: import("@nifrajs/web/server-components/client").ComponentController
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
        component={Summary}
        instanceKey="summary"
        input={{}}
      />
    </main>
  )
}
