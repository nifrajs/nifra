import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

let count = 0

export const backend = server()
  .get("/stats", () => ({
    pctOfRaw: 100,
    reqsPerSec: 118_000,
    adapters: 5,
    runtimes: 4,
  }))
  .get("/count", () => ({ count }))
  .post("/count", () => {
    count += 1
    return { count }
  })
  .post(
    "/playground/chat",
    {
      body: t.object({
        prompt: t.string({ minLength: 1 }),
      }),
    },
    (c) => {
      const promptText = c.body.prompt.toLowerCase()
      let entity = "item"
      let properties = `title: t.string({ minLength: 1 })`
      let mockItem = `{ id: crypto.randomUUID(), title: c.body.title }`
      let requestsJson = `[\n  { "method": "GET", "path": "/items" },\n  { "method": "POST", "path": "/items", "body": { "title": "New Item" } }\n]`

      if (
        promptText.includes("todo") ||
        promptText.includes("task") ||
        promptText.includes("list")
      ) {
        entity = "todo"
        properties = `title: t.string({ minLength: 1 }), completed: t.optional(t.boolean())`
        mockItem = `{ id: crypto.randomUUID(), title: c.body.title, completed: false }`
        requestsJson = `[\n  { "method": "GET", "path": "/todos" },\n  { "method": "POST", "path": "/todos", "body": { "title": "Launch Nifra App" } },\n  { "method": "GET", "path": "/todos" }\n]`
      } else if (
        promptText.includes("user") ||
        promptText.includes("profile") ||
        promptText.includes("member") ||
        promptText.includes("register")
      ) {
        entity = "user"
        properties = `name: t.string({ minLength: 1 }), email: t.string(), age: t.number()`
        mockItem = `{ id: crypto.randomUUID(), name: c.body.name, email: c.body.email, age: c.body.age }`
        requestsJson = `[\n  { "method": "GET", "path": "/users" },\n  { "method": "POST", "path": "/users", "body": { "name": "Ada Lovelace", "email": "ada@nifra.dev", "age": 36 } }\n]`
      } else if (
        promptText.includes("weather") ||
        promptText.includes("temp") ||
        promptText.includes("geo")
      ) {
        entity = "weather"
        properties = `city: t.string()`
        mockItem = `{ city: c.body.city, temp: Math.floor(Math.random() * 15) + 15, condition: "Sunny" }`
        requestsJson = `[\n  { "method": "POST", "path": "/weather", "body": { "city": "San Francisco" } }\n]`
      } else if (
        promptText.includes("product") ||
        promptText.includes("store") ||
        promptText.includes("cart") ||
        promptText.includes("item")
      ) {
        entity = "product"
        properties = `name: t.string(), price: t.number()`
        mockItem = `{ id: crypto.randomUUID(), name: c.body.name, price: c.body.price }`
        requestsJson = `[\n  { "method": "GET", "path": "/products" },\n  { "method": "POST", "path": "/products", "body": { "name": "Premium Keyboard", "price": 129.99 } }\n]`
      }

      const plural = entity === "weather" ? "weather" : `${entity}s`
      const capitalizedEntity = entity.charAt(0).toUpperCase() + entity.slice(1)

      const code = `import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"

// Local memory store for playground simulation
const ${plural}List: any[] = []

export default server()
  .get("/${plural}", () => {
    return ${plural}List
  })
  .post(
    "/${plural}",
    {
      body: t.object({
        ${properties}
      })
    },
    (c) => {
      const newRecord = ${mockItem}
      ${plural}List.push(newRecord)
      c.set.status = 201
      return newRecord
    }
  )
`

      return {
        message: `I've created a custom ${capitalizedEntity} API endpoint structure with input schema validation. You can see it loaded in the app.ts editor, along with corresponding test requests. Click Run to execute it!`,
        code,
        requests: requestsJson,
      }
    },
  )
