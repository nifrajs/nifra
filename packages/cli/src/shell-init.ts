/**
 * `nifra shell tauri` - add a Tauri 2 shell to an existing app: the transport module the pages reach
 * their server through, and the `src-tauri/` project that wraps the static build.
 *
 * Like `init-agents` it writes files only, never overwrites one without `--force`, and touches neither
 * `package.json` nor `nifra.config.ts`: the shell build passes `--transport` itself, so the web build of
 * the same app keeps its own fetch.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type InitAgentsFileResult, writeOwned } from "./init-agents.ts"

export const TRANSPORT_PATH = "frontend/shell-transport.ts"
export const SHELL_DIST = "dist-shell"
export const SHELL_DEV_PORT = 3112
const DEFAULT_ORIGIN = "http://127.0.0.1:3111"

export interface ShellInitOptions {
  /** The server the pages talk to. */
  readonly origin?: string | undefined
  /** The app's display name. Default: `package.json`'s `name`. */
  readonly name?: string | undefined
  /** The bundle identifier. Default `com.example.<name>`. */
  readonly id?: string | undefined
  readonly force?: boolean
}

export interface ShellInitResult {
  readonly files: readonly InitAgentsFileResult[]
  readonly origin: string
  readonly id: string
  readonly name: string
}

/** A name safe as a crate and a library: lower-case letters, digits and `-`, starting with a letter. */
export function crateName(raw: string): string {
  const base = raw
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (base === "") return "app"
  return /^[a-z]/.test(base) ? base : `app-${base}`
}

/** `https://api.example.com/x` -> `https://api.example.com`; throws on anything but an http(s) origin. */
export function originOf(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`[nifra] --origin must be a URL such as https://api.example.com, got "${raw}"`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[nifra] --origin must be http or https, got "${raw}"`)
  }
  return url.origin
}

export function transportSource(origin: string): string {
  return `import { serverFetch } from "@nifrajs/web/shell"

// The pages ship inside the shell; the server is another origin. PUBLIC_SHELL_ORIGIN overrides it per
// build: an Android emulator reaches the host's loopback as 10.0.2.2, the iOS Simulator as 127.0.0.1.
export default serverFetch({ origin: process.env.PUBLIC_SHELL_ORIGIN ?? ${JSON.stringify(origin)} })
`
}

const libName = (crate: string): string => `${crate.replace(/-/g, "_")}_lib`

export function cargoToml(crate: string): string {
  return `[package]
name = ${JSON.stringify(crate)}
version = "0.1.0"
edition = "2021"

[lib]
name = ${JSON.stringify(libName(crate))}
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
`
}

export const BUILD_RS = `fn main() {
    tauri_build::build()
}
`

/**
 * The window opens hidden and shows when the page has painted, so the user never sees the blank
 * window between the web view appearing and the first paint. A timer shows it anyway if no paint
 * is reported, so a page that fails to load cannot leave the app invisible.
 */
export const LIB_RS = `use tauri::{WebviewUrl, WebviewWindowBuilder};

const SHOW_WHEN_PAINTED: &str = r#"
(function () {
  try {
    new PerformanceObserver(function (list) {
      for (var entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          window.__TAURI_INTERNALS__.invoke('shell_painted');
        }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (_) {}
})();
"#;

#[tauri::command]
fn shell_painted(window: tauri::WebviewWindow) {
    let _ = window.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_painted])
        .setup(|app| {
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(SHOW_WHEN_PAINTED);
            #[cfg(desktop)]
            let builder = builder
                .title(app.config().product_name.clone().unwrap_or_default())
                .inner_size(900.0, 640.0)
                .visible(false);
            #[allow(unused_variables)]
            let window = builder.build()?;
            #[cfg(desktop)]
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let _ = window.show();
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
`

export function mainRs(crate: string): string {
  return `// Keeps a release build on Windows from opening a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${libName(crate)}::run()
}
`
}

export const CAPABILITY = `{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default"]
}
`

export function tauriConf(name: string, id: string, origin: string): string {
  const socket = origin.replace(/^http/, "ws")
  const conf = {
    $schema: "https://schema.tauri.app/config/2",
    productName: name,
    version: "0.1.0",
    identifier: id,
    build: {
      frontendDist: `../${SHELL_DIST}`,
      devUrl: `http://localhost:${SHELL_DEV_PORT}`,
      beforeDevCommand: `nifra dev --port ${SHELL_DEV_PORT} --transport ./${TRANSPORT_PATH}`,
      beforeBuildCommand: `nifra build --target static --out ${SHELL_DIST} --transport ./${TRANSPORT_PATH}`,
    },
    app: {
      windows: [],
      security: {
        csp: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${origin} ${socket}`,
      },
    },
    bundle: { active: true, targets: "all" },
  }
  return `${JSON.stringify(conf, null, 2)}\n`
}

export const SHELL_GITIGNORE = `/target/
/gen/schemas
/gen/android/app/build
/gen/android/.gradle
`

async function packageName(cwd: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))
    const name = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "name") : null
    return typeof name === "string" && name !== "" ? name : undefined
  } catch {
    return undefined
  }
}

export async function runShellInit(
  cwd: string,
  options: ShellInitOptions = {},
): Promise<ShellInitResult> {
  const origin = originOf(options.origin ?? DEFAULT_ORIGIN)
  const raw = options.name ?? (await packageName(cwd)) ?? "app"
  const crate = crateName(raw)
  const name = options.name ?? raw.replace(/^@[^/]+\//, "")
  const id = options.id ?? `com.example.${crate.replace(/-/g, "")}`
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(id)) {
    throw new Error(`[nifra] --id must look like com.example.app, got "${id}"`)
  }
  const force = options.force === true
  const entries: readonly (readonly [string, string])[] = [
    [TRANSPORT_PATH, transportSource(origin)],
    ["src-tauri/Cargo.toml", cargoToml(crate)],
    ["src-tauri/build.rs", BUILD_RS],
    ["src-tauri/tauri.conf.json", tauriConf(name, id, origin)],
    ["src-tauri/capabilities/default.json", CAPABILITY],
    ["src-tauri/src/lib.rs", LIB_RS],
    ["src-tauri/src/main.rs", mainRs(crate)],
    ["src-tauri/.gitignore", SHELL_GITIGNORE],
  ]
  const files: InitAgentsFileResult[] = []
  for (const [path, content] of entries) files.push(await writeOwned(cwd, path, content, force))
  return { files, origin, id, name }
}
