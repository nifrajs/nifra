use std::env;
use std::io::BufRead;
use std::net::IpAddr;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl,
};

struct WorkbenchProcess(Mutex<Option<Child>>);

impl WorkbenchProcess {
    fn kill(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn setup_error(error: String) -> tauri::Error {
    tauri::Error::Anyhow(anyhow::anyhow!(error))
}

fn launcher_command() -> Result<(String, Vec<String>), String> {
    if let Ok(command) = env::var("NIFRA_WORKBENCH_COMMAND") {
        return Ok((command, Vec::new()));
    }
    // The default launcher is a path inside a repository checkout, which a packaged app started
    // from Finder or a desktop menu does not run in.
    if !cfg!(debug_assertions) {
        return Err(
            "set NIFRA_WORKBENCH_COMMAND to a trusted launcher, or NIFRA_WORKBENCH_URL to a running Workbench"
                .to_string(),
        );
    }
    Ok((
        "bun".to_string(),
        vec![
            "run".to_string(),
            "apps/workbench/src/server.ts".to_string(),
            "--cwd".to_string(),
            ".".to_string(),
            "--ui-port".to_string(),
            "0".to_string(),
            "--rpc-port".to_string(),
            "0".to_string(),
        ],
    ))
}

fn start_workbench() -> Result<(String, Option<Child>), String> {
    if let Ok(url) = env::var("NIFRA_WORKBENCH_URL") {
        return Ok((url, None));
    }
    let (command, args) = launcher_command()?;
    let mut child = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start Workbench launcher: {error}"))?;
    // Dropping a Child leaves its process running, so a launcher that gave no usable URL is stopped.
    match launcher_url(&mut child) {
        Ok(url) => Ok((url, Some(child))),
        Err(error) => {
            let _ = child.kill();
            Err(error)
        }
    }
}

fn launcher_url(child: &mut Child) -> Result<String, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Workbench launcher has no stdout".to_string())?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("could not read Workbench launcher: {error}"))?;
    Ok(line
        .strip_prefix("Nifra Workbench: ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Workbench launcher did not return a URL".to_string())?
        .to_string())
}

/// The Workbench URL, refused unless it is plain http on a loopback host: the window gets the
/// Workbench's local RPC, so it must never load a page from elsewhere. The error names the origin
/// only, since the URL carries the RPC bearer token.
fn loopback_url(url: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|error| format!("invalid Workbench URL: {error}"))?;
    if !is_loopback_http(&parsed) {
        return Err(format!(
            "Workbench URL must be http on a loopback host, not {}",
            parsed.origin().ascii_serialization()
        ));
    }
    Ok(parsed)
}

fn is_loopback_http(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    url.scheme() == "http"
        && (host == "localhost"
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()))
}

fn build_window(app: &AppHandle, url: tauri::Url) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "workbench", WebviewUrl::External(url))
        // The first URL is checked above; this holds every later top-level navigation, a redirect
        // or a link included, to the same rule.
        .on_navigation(is_loopback_http)
        .title("Nifra Workbench")
        .inner_size(1440.0, 960.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let (url, child) = start_workbench().map_err(setup_error)?;
            let process = WorkbenchProcess(Mutex::new(child));
            // A failed setup never reaches RunEvent::Exit, so the launcher is stopped here.
            if let Err(error) = loopback_url(&url)
                .map_err(setup_error)
                .and_then(|parsed| build_window(app.handle(), parsed))
            {
                process.kill();
                return Err(error.into());
            }
            app.manage(process);
            Ok(())
        })
        .menu(|app| {
            Menu::with_items(
                app,
                &[&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?],
            )
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Nifra Workbench")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(process) = app.try_state::<WorkbenchProcess>() {
                    process.kill();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::loopback_url;

    #[test]
    fn only_a_loopback_http_url_is_loaded() {
        for url in [
            "http://127.0.0.1:4000/?token=t",
            "http://localhost:4000/",
            "http://[::1]:4000/",
        ] {
            assert!(loopback_url(url).is_ok(), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://10.0.0.5:4000/",
            "http://127.0.0.1.example.com/",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(loopback_url(url).is_err(), "{url}");
        }
    }
}
