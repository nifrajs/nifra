import { backend } from "./app.ts"

const port = Number(process.env.PORT ?? 3000)
backend.listen(port)
console.log(`▲ nifra listening on http://localhost:${port}`)
