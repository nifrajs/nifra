export default function neverReady() {
  return new Promise<never>(() => {})
}
