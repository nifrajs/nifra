/** Request-scoped: reads the visitor's cookie. The shell check must keep it out of every shell. */
export const visitorName = (request: Request): string =>
  /(?:^|;\s*)name=([A-Za-z0-9_-]{1,32})/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "guest"
