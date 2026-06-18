const css = `
  :root { --bg:#0a0a0f; --panel:#14141c; --border:#26263a; --fg:#e8e8f0; --muted:#9a9ab0; --accent:#7c5cff; --accent2:#00d4ff; }
  * { box-sizing: border-box; } html { color-scheme: dark; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent2); text-decoration:none; } a:hover { text-decoration:underline; }
  .wrap { max-width:840px; margin:0 auto; padding:0 24px; }
  header.site { border-bottom:1px solid var(--border); } header.site .wrap { display:flex; align-items:center; justify-content:space-between; height:62px; }
  .logo, .logo b { font-weight:800; font-size:20px; } .logo b { background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero { text-align:center; padding:80px 0 56px; }
  .hero h1 { font-size:clamp(36px,6vw,56px); line-height:1.05; margin:0 0 16px; letter-spacing:-0.03em; }
  .hero h1 .grad { background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p { font-size:19px; color:var(--muted); max-width:560px; margin:0 auto 28px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:24px 28px; display:flex; align-items:center; justify-content:space-between; gap:24px; flex-wrap:wrap; }
  .card h3 { margin:0 0 4px; } .card p { margin:0; color:var(--muted); font-size:14px; }
  .count { font-size:34px; font-weight:800; font-variant-numeric:tabular-nums; min-width:44px; text-align:center; background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .btn { background:linear-gradient(90deg,var(--accent),var(--accent2)); color:#0a0a0f; font:inherit; font-weight:700; border:none; cursor:pointer; padding:11px 20px; border-radius:10px; }
  footer.site { border-top:1px solid var(--border); color:var(--muted); font-size:14px; } footer.site .wrap { padding:24px; }
`.trim()

// Solid uses `class` (not `className`); children come through untyped from the compose fold.
export default function Layout(props: { children?: unknown }) {
  return (
    <div id="app">
      <style>{css}</style>
      <header class="site">
        <div class="wrap">
          <a href="/" class="logo">
            <b>nifra</b>
          </a>
          <a href="https://github.com">GitHub</a>
        </div>
      </header>
      <main class="wrap">{props.children as never}</main>
      <footer class="site">
        <div class="wrap">Built with nifra</div>
      </footer>
    </div>
  )
}
