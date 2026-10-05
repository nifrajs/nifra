import type { StandardIssue } from "../schema/standard.ts"
import { type ResponseResult, status } from "./runtime-core.ts"

/** The most issues a 422 body lists: a body of a million bad array items must not answer with a
 * response many times its own size. */
const MAX_VALIDATION_ISSUES = 100

function validationIssues(issues: ReadonlyArray<StandardIssue>): {
  ok: false
  error: string
  issues: unknown[]
} {
  const listed =
    issues.length > MAX_VALIDATION_ISSUES ? issues.slice(0, MAX_VALIDATION_ISSUES) : issues
  const serialized = listed.map((issue) => {
    const path = issue.path?.map((seg) => String(typeof seg === "object" ? seg.key : seg))
    return path !== undefined ? { message: issue.message, path } : { message: issue.message }
  })
  return { ok: false, error: "validation", issues: serialized }
}

/** The shared 422 response result used by every body-validation lane. */
export function plainValidationError(issues: ReadonlyArray<StandardIssue>): ResponseResult {
  return status(422, validationIssues(issues))
}
