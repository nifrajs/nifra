// A route whose loader throws - to demonstrate the nearest `_error.tsx` boundary rendering it.
export const meta = { title: "nifra - boom" }

export default function Boom() {
  return <p>unreachable - the loader threw, so the _error boundary renders instead.</p>
}
