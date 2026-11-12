import { href } from "@nifrajs/web"
import { identityChanged } from "@nifrajs/web/client"
import { RouteSlot, useRouteSlot } from "@nifrajs/web-react/router"

export const routeSlots = {
  inspector: ["/users/:id"],
  activity: ["/activity"],
}

export default function Dashboard() {
  const inspector = useRouteSlot("inspector")
  const activity = useRouteSlot("activity")

  return (
    <main>
      <button
        id="open-activity"
        type="button"
        onClick={() => activity.open(href({ to: "/activity" }))}
      >
        Open activity
      </button>
      <button
        id="open-inspector-7"
        type="button"
        onClick={() => inspector.open(href({ to: "/users/:id", params: { id: "7" } }))}
      >
        Open user 7
      </button>
      <button
        id="open-inspector-8"
        type="button"
        onClick={() => inspector.open(href({ to: "/users/:id", params: { id: "8" } }))}
      >
        Open user 8
      </button>
      <button id="close-inspector" type="button" onClick={() => inspector.close()}>
        Close inspector
      </button>
      <button id="switch-identity" type="button" onClick={switchIdentity}>
        Switch identity
      </button>
      <section id="inspector-slot">
        <RouteSlot
          name="inspector"
          fallback={<p id="inspector-fallback">Inspector loading</p>}
          error={(code) => <p id="inspector-error">Inspector error: {code}</p>}
        />
      </section>
      <section id="activity-slot">
        <RouteSlot
          name="activity"
          fallback={<p id="activity-fallback">Activity loading</p>}
          error={(code) => <p id="activity-error">Activity error: {code}</p>}
        />
      </section>
    </main>
  )
}

function switchIdentity(): void {
  // biome-ignore lint/suspicious/noDocumentCookie: browser fixture changes its request identity.
  document.cookie = "fixture-subject=bob; Path=/; SameSite=Lax"
  identityChanged()
}
