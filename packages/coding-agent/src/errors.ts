const MAX_PUBLIC_ERROR_LENGTH = 4096
const MAX_PUBLIC_STACK_LENGTH = 16 * 1024

export interface PublicErrorDetails {
  readonly message: string
  readonly stack?: string
}

/** Return the useful diagnostic without serializing an Error object or its stack. */
export function publicErrorMessage(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error !== null && typeof error === "object" && "message" in error
          ? (error as { readonly message?: unknown }).message
          : undefined
  if (typeof message !== "string" || message.length === 0) return fallback
  return message.length > MAX_PUBLIC_ERROR_LENGTH
    ? `${message.slice(0, MAX_PUBLIC_ERROR_LENGTH)}…`
    : message
}

/** Add a bounded stack only for an explicitly trusted local diagnostics channel. */
export function publicErrorDetails(
  error: unknown,
  fallback: string,
  includeStack = false,
): PublicErrorDetails {
  const message = publicErrorMessage(error, fallback)
  if (!includeStack || !(error instanceof Error) || typeof error.stack !== "string")
    return { message }
  const stack = error.stack
  return {
    message,
    ...(stack.length === 0
      ? {}
      : {
          stack:
            stack.length > MAX_PUBLIC_STACK_LENGTH
              ? `${stack.slice(0, MAX_PUBLIC_STACK_LENGTH)}…`
              : stack,
        }),
  }
}
