import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({
  id: t.string(),
  viewer: t.string(),
  loads: t.number(),
})

let loads = 0

export const loader = ({
  params,
  request,
}: {
  readonly params: Readonly<Record<string, string>>
  readonly request: Request
}) => {
  const subject = request.headers.get("cookie")?.includes("fixture-subject=bob") ? "bob" : "alice"
  if (subject === "bob" && params.id === "7") throw new Response(null, { status: 403 })

  loads++
  return { id: params.id ?? "", viewer: subject, loads }
}
