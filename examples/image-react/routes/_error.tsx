// The root error boundary: rendered (status 500, non-hydrated) when a route loader throws and this is
// the nearest `_error` in the chain. It receives the serialized error as its `data` — `{ name, message }`
// (never the stack). It renders inside the layout chrome at/above its segment.
export default function ErrorPage(props: { data: { name: string; message: string } }) {
  return (
    <section role="alert">
      <h2 id="error-heading" style={{ color: "#b00020" }}>
        Something went wrong
      </h2>
      <p>
        <strong id="error-name">{props.data.name}</strong>:{" "}
        <span id="error-message">{props.data.message}</span>
      </p>
      <p>
        <a href="/">← Back home</a>
      </p>
    </section>
  )
}
