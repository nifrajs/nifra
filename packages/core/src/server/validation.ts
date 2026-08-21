import type { StandardIssue } from "../schema/standard.ts"
import { type ResponseResult, status } from "./runtime-core.ts"

function validationIssues(issues: ReadonlyArray<StandardIssue>): {
  ok: false
  error: string
  issues: unknown[]
} {
  const serialized = issues.map((issue) => {
    const path = issue.path?.map((seg) => String(typeof seg === "object" ? seg.key : seg))
    return path !== undefined ? { message: issue.message, path } : { message: issue.message }
  })
  return { ok: false, error: "validation", issues: serialized }
}

/** The shared 422 response result used by every body-validation lane. */
export function plainValidationError(issues: ReadonlyArray<StandardIssue>): ResponseResult {
  return status(422, validationIssues(issues))
}
