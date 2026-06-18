// Per-request SSR for `/` — disable Nitro route cache (Nuxt's default favors cached payloads).
export default defineNuxtConfig({
  ssr: true,
  nitro: {
    preset: "node-server",
  },
  routeRules: {
    "/": { cache: false, swr: false },
  },
})
