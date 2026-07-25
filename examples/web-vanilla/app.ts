import { html, type Template } from "@nifrajs/web-vanilla"

export interface PageData {
  message: string
  hotels: ReadonlyArray<{ name: string; pricePaise: number }>
}

// A vanilla route component. Same `data` contract as the React/Preact/Solid/Vue examples - the
// difference is the return type: an auto-escaping `html` template rather than a framework element.
//
// There is no hydration here and nothing to hydrate WITH: the client ships no framework runtime, so
// interactivity comes from an island (see @nifrajs/web/islands), not from this component.
export function App(props: { data: PageData }): Template {
  return html`<main>
    <h1>${props.data.message}</h1>
    <ul>
      ${props.data.hotels.map(
        (hotel) => html`<li>${hotel.name} - Rs ${(hotel.pricePaise / 100).toFixed(2)}</li>`,
      )}
    </ul>
  </main>`
}
