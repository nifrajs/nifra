/** Request-scoped: reads the visitor's cookie. No shell may reach it. */
export const sessionUser = (request: Request): string | undefined =>
  /(?:^|;\s*)user=([A-Za-z0-9_-]{1,32})/.exec(request.headers.get("cookie") ?? "")?.[1]
