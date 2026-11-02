import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({
  viewer: t.string(),
  loads: t.number(),
})

let loads = 0

export const loader = ({ request }: { readonly request: Request }) => {
  loads++
  const viewer = request.headers.get("cookie")?.includes("fixture-subject=bob") ? "bob" : "alice"
  return { viewer, loads }
}
