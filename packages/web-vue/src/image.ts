/**
 * `@nifrajs/web-vue/image` — a CLS-safe responsive Vue `<Image>`. A thin wrapper over `resolveImage` from
 * `@nifrajs/image`: it computes the responsive `<img>` attributes (`src`/`srcset`/`sizes`/`width`/`height`/
 * `loading`/`decoding`/`fetchpriority` via `toHtmlAttrs`) and renders an `<img>`. Extra attributes
 * (`class`, `style`, `id`, `data-*`, listeners) fall through to the `<img>` via Vue's attribute
 * inheritance. Resizing is delegated to the `loader` (an image CDN); nifra bundles no codec. No template.
 */
import { type ImageLoader, type ImageProps, resolveImage, toHtmlAttrs } from "@nifrajs/image"
import { defineComponent, h, type PropType } from "vue"

export const Image = defineComponent({
  name: "NifraImage",
  // Declared props are routed to `props` (not fall-through attrs), so nifra-only props
  // (loader/widths/quality/priority) never leak to the DOM; everything else falls through to <img>.
  props: {
    src: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    alt: { type: String, required: true },
    sizes: { type: String, required: false, default: undefined },
    widths: { type: Array as PropType<readonly number[]>, required: false, default: undefined },
    quality: { type: Number, required: false, default: undefined },
    loading: { type: String as PropType<"lazy" | "eager">, required: false, default: undefined },
    priority: { type: Boolean, required: false, default: undefined },
    loader: { type: Function as PropType<ImageLoader>, required: false, default: undefined },
  },
  setup(props) {
    return () => {
      // Build ImageProps via conditional spreads so an unset optional is *absent*, not `undefined`
      // (exactOptionalPropertyTypes). resolveImage validates width/height > 0 (CLS contract).
      const input: ImageProps = {
        src: props.src,
        width: props.width,
        height: props.height,
        alt: props.alt,
        ...(props.sizes !== undefined ? { sizes: props.sizes } : {}),
        ...(props.widths !== undefined ? { widths: props.widths } : {}),
        ...(props.quality !== undefined ? { quality: props.quality } : {}),
        ...(props.loading !== undefined ? { loading: props.loading } : {}),
        ...(props.priority !== undefined ? { priority: props.priority } : {}),
      }
      return h("img", { ...toHtmlAttrs(resolveImage(input, props.loader)) })
    }
  },
})
