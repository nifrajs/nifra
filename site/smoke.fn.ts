const HIDDEN = "SMOKE_FN_SECRET_999"
export function smokeGreet(name: string): string {
  return `hello ${name} (${HIDDEN})`
}
