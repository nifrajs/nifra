import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no interactivity, so ship zero framework JS.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Hydration & pre-hydration forms",
  "SSR pages become interactive after hydration. nifra keeps that gap safe: progressive-enhancement forms and links work before it, and a JS-only form's broken native submit is guarded automatically.",
)

const POST_FORM = `// Native POST before hydration, client takeover after. Nothing to do.
<form method="post">
  <button type="submit">Save</button>
</form>`

const JS_FORM = `// doc-check: skip — illustrative island: \`FormEvent\` + an app-provided \`authClient\`.
// A form wired purely in JS (preventDefault, no native fallback).
async function onSubmit(e: FormEvent) {
  e.preventDefault()
  await authClient.signIn.email({ email, password })
}
return <form onSubmit={onSubmit}>…</form>`

const OPT_OUT = `<form data-native>…</form>   {/* nifra won't guard it — native submit is intended */}`

const GATE_CSS = `html:not([data-nifra-hydrated]) [data-needs-js] { opacity: 0.6; pointer-events: none; }`

const GATE_JS = `// doc-check: skip — illustrative island: React hooks + your \`onSubmit\`.
const [ready, setReady] = useState(false)
useEffect(() => setReady(true), [])
return <button disabled={!ready} onClick={onSubmit}>Sign in</button>

// or, framework-free:
if (document.documentElement.hasAttribute("data-nifra-hydrated")) start()
else document.addEventListener("nifra:hydrated", start, { once: true })`

export default function Hydration() {
  return (
    <div className="prose">
      <h1 className="page">Hydration &amp; pre-hydration forms</h1>
      <p className="lead">
        An SSR page is visible at once but interactive only after its island hydrates. nifra keeps
        that gap safe for you — you rarely have to think about it.
      </p>

      <h2>Forms and links — nothing to do</h2>
      <p>
        A <code>{"<form method=\"post\">"}</code> to a route, and any <code>{"<a href>"}</code>, use
        progressive enhancement: native submit/navigation before hydration, a no-reload client
        takeover after.
      </p>
      <CodeBlock code={POST_FORM} />

      <h2>JS-only forms — guarded automatically</h2>
      <p>
        The one risky shape is a form wired purely in JavaScript — a <code>preventDefault</code>{" "}
        handler with no native fallback. Submitted before hydration, the browser would fall back to a
        native GET of the current page (<code>/?email=…</code>), a broken navigation.
      </p>
      <CodeBlock code={JS_FORM} />
      <p>
        nifra blocks that native submit until hydration commits, so the worst case is a no-op click —
        never a broken navigation. It never touches a <code>method="post"</code> form or a GET form
        with a real action. Opt a form out with <code>data-native</code>:
      </p>
      <CodeBlock code={OPT_OUT} />

      <h2>Gate other JS on the signal</h2>
      <p>
        For a visible “not ready” state, or a non-form interaction (canvas, drag-drop, a third-party
        widget), gate on <code>data-nifra-hydrated</code> (set on <code>&lt;html&gt;</code> once
        hydration commits) or the one-shot <code>nifra:hydrated</code> event.
      </p>
      <CodeBlock code={GATE_CSS} />
      <CodeBlock code={GATE_JS} />
    </div>
  )
}
