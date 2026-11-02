// biome-ignore lint/plugin/noHelperCopy: Matching guards are private to unrelated JWT and test boundaries.
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
