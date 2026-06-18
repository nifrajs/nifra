export default defineNuxtConfig({
  ssr: true,
  nitro: {
    preset: "node-server",
  },
  routeRules: {
    "/": { prerender: true },
  },
})
