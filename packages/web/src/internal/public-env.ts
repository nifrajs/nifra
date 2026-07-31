/** Translate Nifra's public-env contract to Vite's `envPrefix` option. */
export function vitePublicEnvPrefix(prefix: string | undefined): string {
  const configured = prefix ?? "PUBLIC_"
  // Vite rejects an empty prefix. Environment-variable names cannot contain NUL, so this sentinel
  // cannot match an ambient key and faithfully represents Nifra's "expose nothing" setting.
  return configured === "" ? "\0nifra-public-env-disabled" : configured
}
