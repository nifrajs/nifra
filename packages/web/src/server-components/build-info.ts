declare const __NIFRA_COMPONENT_BUILD__: string

/** The coordinated compiler replaces this value in every environment. */
export const componentBuild: string =
  typeof __NIFRA_COMPONENT_BUILD__ === "string"
    ? __NIFRA_COMPONENT_BUILD__
    : (() => {
        throw new Error(
          "[nifra/components] build-info requires serverComponentsConfig or nifra build",
        )
      })()
