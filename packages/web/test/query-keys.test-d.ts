import { type QueryClient, queryKey } from "../src/query.ts"

/**
 * Type-level tests for typed query keys. A key made with `queryKey<T>` ties the data type to the key, and
 * a plain key stays usable, including when a caller names only the data type: that call must not let a
 * typed key of another data type through.
 */

declare const client: QueryClient
const strings = async () => "x"
const numbers = async () => 1

// A plain key, with the data type inferred or named.
client.query(["k"], strings)
client.query<string>(["k"], strings)
client.query<string>("k", strings)
client.query<string>({ scope: "a" }, strings)
client.prefetchQuery<string>(["k"], strings)

// A key declared as an interface or a type alias is a plain key too.
interface InterfaceKey {
  readonly scope: string
}
type AliasKey = { readonly scope: string }
declare const interfaceKey: InterfaceKey
declare const aliasKey: AliasKey
client.query<number>(interfaceKey, numbers)
client.query<number>(aliasKey, numbers)
client.prefetchQuery<number>(interfaceKey, numbers)

// A typed key takes its own data type, inferred or named.
client.query(queryKey<string>(["n"]), strings)
client.query<number>(queryKey<number>(["n"]), numbers)

// @ts-expect-error the fetcher returns a string under a key of numbers
client.query(queryKey<number>(["n"]), strings)
// @ts-expect-error naming the data type does not turn the key into a plain one
client.query<string>(queryKey<number>(["n"]), strings)
// @ts-expect-error the same holds for a prefetch
client.prefetchQuery<string>(queryKey<number>(["n"]), strings)

// A key typed by its data type stays an array when it was one.
const todos = queryKey<{ id: number }[]>(["todos"])
export const child = [...todos, "detail"]
export const first: unknown = todos[0]
export const length: number = todos.length
// A key that is not an array is typed too.
export const named = queryKey<number>("count")
