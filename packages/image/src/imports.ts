/** Include with `/// <reference types="@nifrajs/image/imports" />` in the app's env.d.ts. */
declare module "*?image" {
  const image: import("@nifrajs/image").StaticImageData
  export default image
}
