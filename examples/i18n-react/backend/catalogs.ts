import type { Messages } from "@nifrajs/i18n"

/** Demo catalogs (inline for brevity). A real app loads per-locale JSON - and, for many locales, lazily
 * (don't bundle every catalog into the client). The loader returns just the active locale's messages. */
export const locales = ["en", "fr"] as const

/** The base language's catalog: the fallback for a locale without one. */
export const baseCatalog: Messages = {
  greeting: "Hello, {name}!",
  cart: "{count, plural, =0 {Your cart is empty} one {# item in your cart} other {# items in your cart}}",
  price: "Total: {amount}",
  language: "Language",
}

export const catalogs: Record<string, Messages> = {
  en: baseCatalog,
  fr: {
    greeting: "Bonjour, {name} !",
    cart: "{count, plural, =0 {Votre panier est vide} one {# article dans votre panier} other {# articles dans votre panier}}",
    price: "Total : {amount}",
    language: "Langue",
  },
}
