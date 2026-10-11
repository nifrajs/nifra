import { COMPONENT_ERROR_CODES, type ComponentErrorCode, ServerComponentError } from "./error.ts"
import { COMPONENT_LIMITS } from "./protocol.ts"
import { readComponentBytes } from "./stream.ts"
import { componentValue } from "./value.ts"

/** Read a small terminal envelope; an ordinary owner error keeps its HTTP status and safe code. */
export async function componentResponseFailure(
  response: Response,
  signal: AbortSignal,
): Promise<ServerComponentError> {
  if (
    response.body === null ||
    response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return new ServerComponentError("component_failed", response.status)
  let value: unknown
  try {
    value = componentValue(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readComponentBytes(response.body, signal, COMPONENT_LIMITS.headerBytes),
        ),
      ),
      COMPONENT_LIMITS.headerBytes,
    )
  } catch (error) {
    if (error instanceof ServerComponentError) throw error
    return new ServerComponentError("component_failed", response.status)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return new ServerComponentError("component_failed", response.status)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The bounded error envelope and exact error-code vocabulary are checked before constructing the typed failure.
  const envelope = value as Record<string, unknown>
  if (
    Object.keys(envelope).length !== 2 ||
    envelope.v !== 1 ||
    typeof envelope.error !== "string" ||
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The bounded error envelope and exact error-code vocabulary are checked before constructing the typed failure.
    !(COMPONENT_ERROR_CODES as readonly string[]).includes(envelope.error)
  )
    return new ServerComponentError("component_failed", response.status)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The bounded error envelope and exact error-code vocabulary are checked before constructing the typed failure.
  return new ServerComponentError(envelope.error as ComponentErrorCode, response.status)
}
