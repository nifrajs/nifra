import { closeBoundary } from "@nifrajs/web/client"
import { Hole } from "@nifrajs/web-react/ppr"

const greeting = {
  name: "greeting",
  mode: "dynamic" as const,
  render: (data: { readonly name: string }) => <p id="greeting">hello {data.name}</p>,
  fallback: <p id="greeting-fallback">loading greeting</p>,
}
// No load of its own: the modal shows the photo route's loader data.
const photo = {
  name: "photo",
  mode: { intercept: "/photo/:id" },
  render: (data: { readonly title?: string } | undefined) => (
    <h2 id="modal-title">{data?.title}</h2>
  ),
}

export const boundaries = [greeting, photo]

type BoundaryStates = Readonly<
  Record<
    string,
    {
      readonly status: "unresolved" | "pending" | "ready" | "error"
      readonly data?: { readonly title?: string }
      readonly ppr?: true
    }
  >
>

export default function Gallery(props: {
  readonly data: { readonly title: string }
  readonly boundaries?: BoundaryStates
}) {
  const open = props.boundaries?.photo
  return (
    <main>
      <h1 id="title">{props.data.title}</h1>
      <input id="probe" />
      <Hole of={greeting} state={props.boundaries?.greeting} />
      <a id="to-photo-7" href="/photo/7">
        photo 7
      </a>{" "}
      <a id="to-photo-8" href="/photo/8">
        photo 8
      </a>
      {open?.status === "ready" ? (
        <dialog open data-nifra-boundary="photo">
          {photo.render(open.data)}
          <button id="close" type="button" onClick={() => closeBoundary("photo")}>
            close
          </button>
        </dialog>
      ) : null}
    </main>
  )
}
