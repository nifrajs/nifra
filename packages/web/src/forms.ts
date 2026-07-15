/**
 * `@nifrajs/web/forms` — a typed form ↔ backend-schema binding. The three artifacts that must agree —
 * a form's `<input name>`, the action's `formData.get`, and the typed-client payload — all key off the
 * ONE route body schema, derived purely from `typeof backend`. A typo'd field name, or a field the
 * schema doesn't have, becomes a COMPILE error instead of a silent runtime empty.
 *
 *   import type { backend } from "../backend"
 *   import { formFor } from "@nifrajs/web/forms"
 *
 *   const f = formFor<typeof backend, "/todos">()   // method defaults to "post"
 *   // In the component (any framework — spread the props onto an input):
 *   <input {...f.field("text")} />                  // "text" ∈ the body's keys, else a compile error
 *   // In the action:
 *   const text = f.read(await request.formData(), "text")   // an orphan key won't compile
 *   await api.todos.post({ text })                  // payload already typed by nifra
 *
 * Framework-agnostic + dependency-free: no codegen, no schema is bundled into the client, and the
 * runtime is a trivial pass-through — all the work is in the types. It checks the field KEY, never the
 * MEANING (a `field("email")` collecting a phone is still valid here); that stays an app/AI concern.
 */
import type { RouteInfo, Server } from "@nifrajs/core/server"

// Derived from `FormData` itself (not the `FormDataEntryValue` global) so this file stays DOM-lib-free:
// `@nifrajs/web`'s server surface is typechecked by the root config, which has no DOM lib.
type FormEntry = ReturnType<FormData["get"]>
type FormEntries = ReturnType<FormData["getAll"]>

/** The route registry baked into a server's type (`typeof app`). */
type RegistryOf<App> = App extends Server<infer R, infer _Ctx> ? R : never

/** Every route path the app declares — constrains `Path`, so a wrong path is itself a type error. */
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

/** The valid field names for that route's body — the schema's keys as a string union. */
export type FieldKey<App, Path extends string, Method extends string> = [
  RouteBody<App, Path, Method>,
] extends [never]
  ? never
  : keyof RouteBody<App, Path, Method> & string

/** Extra attributes merged into the returned input props (id, type, defaultValue, placeholder, …). */
export type FieldProps = Record<string, unknown>

export interface FormHandle<App, Path extends string, Method extends string> {
  /** Input props for a schema field. `name` is constrained to the body's keys — a typo, or a field the
   * schema doesn't have, is a COMPILE error. Spread onto an element: `<input {...f.field("text")} />`. */
  field<K extends FieldKey<App, Path, Method>>(
    name: K,
    props?: FieldProps,
  ): FieldProps & { name: K }
  /** `formData.get`, key-constrained to the body's fields — reading an orphan key won't compile. */
  read<K extends FieldKey<App, Path, Method>>(form: FormData, name: K): FormEntry
  /** `formData.getAll`, key-checked the same way. */
  readAll<K extends FieldKey<App, Path, Method>>(form: FormData, name: K): FormEntries
}

/**
 * Bind a form to a backend route's body schema at the type level. `App` is `typeof backend`; `Path` is
 * constrained to the app's real routes (a wrong path is a type error); `Method` defaults to `"post"`.
 */
export function formFor<
  App,
  Path extends RoutePaths<App>,
  Method extends string = "post",
>(): FormHandle<App, Path, Method> {
  const handle = {
    field: (name: string, props?: FieldProps): FieldProps & { name: string } => ({
      ...(props ?? {}),
      name,
    }),
    read: (form: FormData, name: string): FormEntry => form.get(name),
    readAll: (form: FormData, name: string): FormEntries => form.getAll(name),
  }
  return handle as unknown as FormHandle<App, Path, Method>
}
