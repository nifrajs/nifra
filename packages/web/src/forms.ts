/**
 * `@nifrajs/web/forms` - a typed form ↔ backend-schema binding. The three artifacts that must agree -
 * a form's `<input name>`, the action's `formData.get`, and the typed-client payload - all key off the
 * ONE route body schema, derived purely from `typeof backend`. A typo'd field name, or a field the
 * schema doesn't have, becomes a COMPILE error instead of a silent runtime empty.
 *
 *   import type { backend } from "../backend"
 *   import { formFor } from "@nifrajs/web/forms"
 *
 *   const f = formFor<typeof backend>()("/todos")   // a route the app has; method defaults to "post"
 *   // In the component (any framework - spread the props onto the form and its inputs):
 *   <form action={f.action} method={f.method}>      // the route's own URL and method, never retyped
 *   <input {...f.field("text")} />                  // "text" ∈ the body's keys, else a compile error
 *   // In the action:
 *   const text = f.read(await request.formData(), "text")   // an orphan key won't compile
 *   await api.todos.post({ text })                  // payload already typed by nifra
 *
 * Framework-agnostic + dependency-free: no codegen, no schema is bundled into the client, and the
 * runtime is a trivial pass-through - all the work is in the types. It checks the field KEY, never the
 * MEANING (a `field("email")` collecting a phone is still valid here); that stays an app/AI concern.
 */
import type { RouteInfo, Server } from "@nifrajs/core/server"

// Derived from `FormData` itself (not the `FormDataEntryValue` global) so this file stays DOM-lib-free:
// `@nifrajs/web`'s server surface is typechecked by the root config, which has no DOM lib.
type FormEntry = ReturnType<FormData["get"]>
type FormEntries = ReturnType<FormData["getAll"]>

/** The route registry baked into a server's type (`typeof app`). */
type RegistryOf<App> = App extends Server<infer R, infer _Ctx> ? R : never

/** Every route path the app declares - constrains `Path`, so a wrong path is itself a type error. */
export type RoutePaths<App> = keyof RegistryOf<App> & string

/** The body object type of `App`'s `Method Path` route (`never` when the route declares no body). */
export type RouteBody<
  App,
  Path extends string,
  Method extends string,
> = Path extends keyof RegistryOf<App>
  ? Uppercase<Method> extends keyof RegistryOf<App>[Path]
    ? (RegistryOf<App>[Path][Uppercase<Method>] & RouteInfo)["body"]
    : never
  : never

/** The valid field names for that route's body - the schema's keys as a string union. */
export type FieldKey<App, Path extends string, Method extends string> = [
  RouteBody<App, Path, Method>,
] extends [never]
  ? never
  : keyof RouteBody<App, Path, Method> & string

/** Extra attributes merged into the returned input props (id, type, defaultValue, placeholder, …). */
export type FieldProps = Record<string, unknown>

/** The lowercase methods `App` declares for `Path`: what a form for that route may use. */
export type RouteMethods<App, Path extends string> = Path extends keyof RegistryOf<App>
  ? Lowercase<keyof RegistryOf<App>[Path] & string>
  : never

export interface FormHandle<App, Path extends string, Method extends string> {
  /** The route's URL, for `<form action>`: the path the handle was made for. */
  readonly action: Path
  /** The route's method, lowercase, for `<form method>` or a `fetch`. */
  readonly method: Method
  /** Input props for a schema field. `name` is constrained to the body's keys - a typo, or a field the
   * schema doesn't have, is a COMPILE error. Spread onto an element: `<input {...f.field("text")} />`. */
  field<K extends FieldKey<App, Path, Method>>(
    name: K,
    props?: FieldProps,
  ): FieldProps & { name: K }
  /** `formData.get`, key-constrained to the body's fields - reading an orphan key won't compile. */
  read<K extends FieldKey<App, Path, Method>>(form: FormData, name: K): FormEntry
  /** `formData.getAll`, key-checked the same way. */
  readAll<K extends FieldKey<App, Path, Method>>(form: FormData, name: K): FormEntries
}

/**
 * Bind a form to a backend route at the type level. `App` is `typeof backend`; the path is one of the
 * app's real routes (a wrong path is a type error), and the method one that route declares (default
 * `"post"`). The handle carries the route's own `action` and `method`, and checks every field name against
 * the route's body schema.
 */
export function formFor<App>(): <
  Path extends RoutePaths<App>,
  Method extends RouteMethods<App, Path> = Extract<"post", RouteMethods<App, Path>>,
>(
  path: Path,
  method?: Method,
) => FormHandle<App, Path, Method> {
  return (path, method) =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the runtime holds a path and a method; the handle's constraints are compile-time only
    ({
      action: path,
      method: method ?? "post",
      field: (name: string, props?: FieldProps): FieldProps & { name: string } => ({
        ...(props ?? {}),
        name,
      }),
      read: (form: FormData, name: string): FormEntry => form.get(name),
      readAll: (form: FormData, name: string): FormEntries => form.getAll(name),
    }) as FormHandle<App, typeof path, NonNullable<typeof method>>
}
