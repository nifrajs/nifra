import type { ReactNode } from "react"

const MONO = `"SF Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace`

const css = `
  :root {
    color-scheme: light;
    --bg: #f8fafc;
    --fg: #0f172a;
    --muted: #475569;
    --soft: #334155;
    --line: #e2e8f0;
    --line-2: #cbd5e1;
    --panel: #f1f5f9;
    --panel-2: #e2e8f0;
    --surface: #ffffff;
    --header-bg: rgba(248, 250, 252, 0.8);
    --hover: rgba(15, 23, 42, 0.05);
    --bar-fill: #cbd5e1;
    --green: #06b6d4;
    --green-2: #6366f1;
    --green-soft: #f0f9ff;
    --amber: #d97706;
    --link: #4f46e5;
    --ink: #090d16;
    --shadow: 0 10px 30px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.02);
    --code-bg: #f8fafc;
    --code-fg: #0f172a;
    --code-border: #e2e8f0;
    --code-keyword: #7c3aed;
    --code-string: #0d9488;
    --code-comment: #64748b;
    --code-literal: #0284c7;
    --agent-bg: #ffffff;
    --agent-border: #e2e8f0;
    --agent-fg: #0f172a;
    --agent-muted: #475569;
    --agent-head-fg: #64748b;
    --agent-grid-bg: #cbd5e1;
    --agent-step-bg: #ffffff;
    --agent-code-bg: #e0f2fe;
    --agent-code-border: rgba(6, 182, 212, 0.2);
    --agent-code-fg: #0369a1;
    --agent-accent: #6366f1;
    --agent-shadow: 0 20px 40px rgba(99, 102, 241, 0.05);
    --radius: 12px;
    --radius-lg: 18px;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #030712;
    --fg: #f3f4f6;
    --muted: #9ca3af;
    --soft: #d1d5db;
    --line: #111827;
    --line-2: #1f2937;
    --panel: #0b0f19;
    --panel-2: #111827;
    --surface: #0b0f19;
    --header-bg: rgba(3, 7, 18, 0.8);
    --hover: rgba(255, 255, 255, 0.06);
    --bar-fill: #1f2937;
    --green: #22d3ee;
    --green-2: #a78bfa;
    --green-soft: rgba(34, 211, 238, 0.08);
    --amber: #fbbf24;
    --link: #a78bfa;
    --ink: #010409;
    --shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    --code-bg: #070a13;
    --code-fg: #e5e7eb;
    --code-border: #111827;
    --code-keyword: #f472b6;
    --code-string: #34d399;
    --code-comment: #6b7280;
    --code-literal: #60a5fa;
    --agent-bg: #0b0f19;
    --agent-border: #1f2937;
    --agent-fg: #f3f4f6;
    --agent-muted: #9ca3af;
    --agent-head-fg: #6b7280;
    --agent-grid-bg: #1f2937;
    --agent-step-bg: #0b0f19;
    --agent-code-bg: rgba(34, 211, 238, 0.08);
    --agent-code-border: rgba(34, 211, 238, 0.15);
    --agent-code-fg: #22d3ee;
    --agent-accent: #a78bfa;
    --agent-shadow: 0 20px 40px rgba(167, 139, 250, 0.12);
  }
  /* Theme toggle (top-right): sun in light, moon in dark. */
  .theme-toggle {
    display: inline-grid; place-items: center; width: 38px; height: 38px; margin-left: 4px;
    border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface);
    color: var(--muted); cursor: pointer;
    flex: 0 0 auto;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .theme-toggle:hover { color: var(--fg); border-color: rgba(22, 163, 74, 0.4); background: var(--panel); }
  .theme-toggle svg { width: 18px; height: 18px; }
  .theme-toggle .moon { display: none; }
  :root[data-theme="dark"] .theme-toggle .sun { display: none; }
  :root[data-theme="dark"] .theme-toggle .moon { display: block; }

  * { box-sizing: border-box; }
  html { background: var(--bg); scroll-behavior: smooth; overflow-x: clip; }
  #app { position: relative; isolation: isolate; }
  .site-atmosphere {
    position: absolute; inset: 0 0 auto 0; z-index: 0;
    height: min(70vh, 680px); pointer-events: none;
    background: 
      radial-gradient(circle at 50% -20%, rgba(99, 102, 241, 0.15) 0%, rgba(34, 211, 238, 0.05) 50%, transparent 100%),
      linear-gradient(to bottom, rgba(3, 7, 18, 0.4), rgba(3, 7, 18, 0.8)),
      url(/assets/background.png) center top / cover no-repeat;
    mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%);
  }
  :root[data-theme="light"] .site-atmosphere { opacity: 0.6; }
  :root[data-theme="dark"] .site-atmosphere { opacity: 1; }
  #app > header.site, #app > main, #app > footer.site { position: relative; z-index: 1; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.6 "Inter", "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
    overflow-x: clip;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4, .logo, .button {
    font-family: "Outfit", "Inter", sans-serif;
  }
  code, pre {
    font-family: "JetBrains Mono", ${MONO};
  }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--green-2); text-decoration: underline; }
  button, input, textarea, select { font: inherit; }
  a:focus-visible, button:focus-visible, summary:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid var(--green-2); outline-offset: 2px; border-radius: 6px;
  }

  .wrap { width: min(calc(100% - 40px), 1140px); margin: 0 auto; }

  /* ---- header / footer ---- */
  header.site {
    position: sticky; top: 0; z-index: 30;
    border-bottom: 1px solid var(--line);
    background: var(--header-bg);
    backdrop-filter: blur(14px);
  }
  header.site .wrap {
    display: flex; align-items: center; justify-content: space-between;
    height: 64px; gap: 24px;
  }
  .logo { display: inline-flex; align-items: center; gap: 10px; color: var(--fg); font-weight: 800; font-size: 20px; }
  .logo:hover { text-decoration: none; }
  .logo-mark {
    display: block; width: 48px; height: 48px; flex-shrink: 0;
    object-fit: contain; object-position: center; border-radius: 8px;
  }
  :root[data-theme="light"] .logo-mark { box-shadow: 0 0 0 1px var(--line-2); }
  .logo-badge {
    font-family: ${MONO}; font-size: 10px; font-weight: 700; color: var(--green-2);
    background: var(--green-soft); border: 1px solid rgba(22, 163, 74, 0.2);
    padding: 2px 7px; border-radius: 99px; letter-spacing: 0.04em; text-transform: uppercase;
  }
  nav.top { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
  nav.top a { color: var(--muted); font-size: 14px; font-weight: 600; padding: 8px 11px; border-radius: 7px; }
  nav.top a:hover { color: var(--fg); background: var(--hover); text-decoration: none; }

  footer.site { border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
  footer.site .wrap { padding: 28px 0; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; }

  /* ---- buttons / install ---- */
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 46px; padding: 0 20px; border-radius: var(--radius);
    border: 1px solid transparent; font-weight: 700; line-height: 1; white-space: nowrap;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .button:hover { text-decoration: none; transform: translateY(-2px); }
  .button.primary { 
    color: #fff; 
    background: linear-gradient(135deg, var(--green-2), var(--green)); 
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25); 
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .button.primary:hover { 
    color: #fff; 
    box-shadow: 0 12px 28px rgba(99, 102, 241, 0.35); 
    filter: brightness(1.05); 
  }
  .button.ghost { color: var(--fg); border-color: var(--line-2); background: var(--surface); }
  .button.ghost:hover { background: var(--panel); border-color: var(--green); box-shadow: 0 4px 12px rgba(6, 182, 212, 0.08); }

  .install-widget {
    display: inline-flex; align-items: center; justify-content: space-between;
    min-height: 46px; min-width: 250px; padding: 0 16px;
    border: 1px solid var(--line-2); border-radius: var(--radius);
    background: var(--surface); color: var(--fg);
    font-family: 'JetBrains Mono', ${MONO}; font-size: 14px; cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); text-align: left;
    box-shadow: var(--shadow);
  }
  .install-widget:hover { 
    border-color: var(--green); 
    box-shadow: 0 0 0 4px var(--green-soft), 0 8px 20px rgba(0, 0, 0, 0.05); 
    transform: translateY(-2px);
  }
  .install-widget .prompt { color: var(--green); margin-right: 8px; user-select: none; font-weight: 700; }
  .install-widget .command { flex-grow: 1; }
  .install-widget .copy-btn { display: inline-flex; align-items: center; margin-left: 14px; color: var(--muted); transition: color 0.15s ease; }
  .install-widget:hover .copy-btn { color: var(--green); }
  .install-widget .copy-icon { width: 15px; height: 15px; }
  .install-widget .copied-toast { display: none; color: var(--green); font-size: 12px; font-weight: 700; }
  .install-widget[data-copied="true"] .copied-toast { display: inline; }
  .install-widget[data-copied="true"] .copy-icon { display: none; }

  /* ---- hero ---- */
  .hero {
    display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
    align-items: center; gap: 42px; padding: 70px 0 56px;
  }
  .hero-copy {
    display: flex; flex-direction: column; align-items: flex-start; text-align: left;
    width: 100%; max-width: 680px; gap: 24px;
  }
  .hero-badge {
    display: inline-flex; align-items: center; gap: 9px; padding: 6px 14px; margin: 0;
    border: 1px solid rgba(22, 163, 74, 0.22); border-radius: 99px;
    background: var(--green-soft); color: var(--green-2); font-size: 13px; font-weight: 600;
  }
  .badge-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); position: relative; }
  .badge-dot::after {
    content: ""; position: absolute; inset: -4px; border-radius: 50%;
    background: var(--green); opacity: 0.35; animation: pulse 2s cubic-bezier(0.24, 0, 0.38, 1) infinite;
  }
  @keyframes pulse { 0% { transform: scale(1); opacity: 0.5; } 100% { transform: scale(2.4); opacity: 0; } }
  .hero h1 { margin: 0; font-size: clamp(38px, 5.2vw, 62px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; }
  .hero h1 em { font-style: normal; color: var(--green); }
  .hero .tagline {
    margin: 0; max-width: 650px; color: var(--soft);
    font-size: clamp(17px, 1.55vw, 20px); line-height: 1.6;
  }
  .hero-actions {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start;
    gap: 12px; margin-top: 4px;
  }
  .hero-fineprint {
    margin: -8px 0 0; color: var(--muted); font-family: ${MONO}; font-size: 12px;
  }
  .agent-board {
    border: 1px solid var(--agent-border); border-radius: var(--radius-lg);
    background: var(--agent-bg);
    color: var(--agent-fg); box-shadow: var(--agent-shadow);
    overflow: hidden;
  }
  .agent-board-head {
    display: flex; align-items: center; gap: 9px; padding: 13px 16px;
    border-bottom: 1px solid var(--agent-border);
    font-family: ${MONO}; font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--agent-head-fg);
  }
  .agent-led {
    width: 8px; height: 8px; border-radius: 50%; background: var(--agent-accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--agent-accent) 18%, transparent);
  }
  .agent-board-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--agent-grid-bg); }
  .agent-step {
    display: grid; grid-template-columns: 34px 1fr; gap: 12px; padding: 18px 16px;
    background: var(--agent-step-bg);
  }
  .agent-step-no {
    font-family: ${MONO}; font-size: 12px; font-weight: 800; color: var(--agent-accent);
  }
  .agent-step code {
    display: inline-block; margin: 0 0 8px; color: var(--agent-code-fg);
    font-family: ${MONO}; font-size: 12px; background: var(--agent-code-bg);
    border: 1px solid var(--agent-code-border); border-radius: 5px; padding: 1px 7px;
  }
  .agent-step h2 {
    margin: 0; color: var(--agent-fg); font-size: 17px; line-height: 1.22; letter-spacing: 0;
  }
  .agent-step p {
    margin: 7px 0 0; color: var(--agent-muted); font-size: 13px; line-height: 1.45;
  }

  /* ---- benchmark bars ---- */
  .bench-card {
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); padding: 22px 24px 18px; box-shadow: var(--shadow);
  }
  .bench-card figcaption { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
  .bench-kicker { color: var(--fg); font-weight: 700; font-size: 14px; font-family: ${MONO}; }
  .bench-sub { color: var(--muted); font-size: 12.5px; }
  .bars { display: grid; gap: 13px; }
  .bar-row { 
    display: grid; grid-template-columns: 148px 1fr 72px; align-items: center; gap: 14px; 
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .bar-row:hover { transform: translateX(6px); }
  .bar-name { color: var(--muted); font-size: 13px; font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-row.you .bar-name { color: var(--fg); font-weight: 700; }
  .bar-track { height: 26px; border-radius: 6px; background: var(--panel-2); overflow: hidden; }
  .bar-fill {
    display: block; height: 100%; border-radius: 6px; background: var(--bar-fill); transform-origin: left;
    animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .bar-row.you .bar-fill { background: linear-gradient(90deg, var(--green-2), var(--green)); }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .bar-value { font-family: ${MONO}; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--soft); text-align: right; }
  .bar-row.you .bar-value { color: var(--green-2); font-weight: 700; }
  .bench-foot { margin: 18px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  code.inline, .bench-foot code, .section-head code {
    font-family: ${MONO}; color: var(--green-2); background: var(--green-soft);
    border: 1px solid rgba(22, 163, 74, 0.18); border-radius: 5px; padding: 1px 6px; font-size: 0.85em;
  }
  .bench-duo { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .runtime-strip {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
  }
  .runtime-card {
    padding: 22px 20px; border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); text-align: center; box-shadow: var(--shadow);
  }
  .runtime-card.you { border-color: rgba(22, 163, 74, 0.28); background: linear-gradient(180deg, var(--green-soft), var(--surface)); }
  .runtime-name {
    display: block; font-family: ${MONO}; font-size: 12px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
  }
  .runtime-reqs {
    display: block; margin-top: 10px; font-size: clamp(28px, 3.6vw, 38px);
    line-height: 1; letter-spacing: -0.02em; color: var(--green-2);
  }
  .runtime-unit { display: block; margin-top: 6px; font-size: 12.5px; color: var(--muted); }
  .runtime-pct {
    display: inline-block; margin-top: 12px; padding: 3px 10px; border-radius: 99px;
    font-family: ${MONO}; font-size: 11.5px; font-weight: 700; color: var(--green-2);
    background: var(--green-soft); border: 1px solid rgba(22, 163, 74, 0.2);
  }

  /* ---- proof strip ---- */
  .proof {
    display: grid; grid-template-columns: repeat(4, 1fr);
    border: 1px solid var(--line); border-radius: var(--radius-lg); overflow: hidden;
    background: var(--surface); margin: 6px 0 64px; box-shadow: var(--shadow);
  }
  .proof-item { padding: 26px 24px; border-right: 1px solid var(--line); }
  .proof-item:last-child { border-right: none; }
  .proof-item strong { display: block; font-size: clamp(26px, 3vw, 36px); line-height: 1; letter-spacing: -0.02em; color: var(--fg); }
  .proof-item:first-child strong { color: var(--green-2); }
  .proof-item span { display: block; margin-top: 10px; max-width: 200px; color: var(--muted); font-size: 13.5px; line-height: 1.4; }

  /* ---- multiplier grid (frontend perf headline numbers) ---- */
  .mult-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .mult-item { padding: 26px 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); text-align: center; box-shadow: var(--shadow); }
  .mult-item strong { display: block; font-size: clamp(34px, 4.4vw, 50px); line-height: 1; letter-spacing: -0.02em; font-weight: 800; color: var(--green-2); }
  .mult-item span { display: block; margin-top: 12px; color: var(--muted); font-size: 13.5px; }

  /* ---- generic section ---- */
  .section { margin: 0 0 64px; }
  .section-head { max-width: 640px; margin: 0 0 32px; }
  .kicker {
    display: inline-block; margin: 0 0 14px; color: var(--green-2);
    font-family: ${MONO}; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .section-head h2 { margin: 0; font-size: clamp(30px, 4vw, 44px); line-height: 1.08; letter-spacing: -0.025em; font-weight: 800; }
  .section-head p { margin: 18px 0 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
  .note { margin: 22px 0 0; color: var(--muted); font-size: 14px; }

  /* ---- feature showcase ---- */
  .feature-showcase {
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    gap: 64px;
    align-items: center;
    margin: 96px 0;
  }
  .feature-showcase.reverse {
    grid-template-columns: 1.15fr 1fr;
  }
  .feature-showcase.reverse .feature-info {
    order: 2;
  }
  /* The code block is now wrapped in .code-window (the grid child) — target that for placement. */
  .feature-showcase .code-window { margin: 0; }
  .feature-showcase.reverse .code-window {
    order: 1;
  }
  .feature-info {
    max-width: 500px;
  }
  .feature-info h2 {
    font-size: clamp(28px, 3.4vw, 40px);
    line-height: 1.1;
    font-weight: 800;
    margin: 0 0 16px;
    letter-spacing: -0.025em;
    color: var(--fg);
  }
  .feature-info p {
    font-size: 15.5px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 0 20px;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .chip {
    padding: 5px 12px; border: 1px solid var(--line-2); border-radius: 99px;
    background: var(--panel); color: var(--soft); font-size: 13px; font-weight: 600;
    font-family: ${MONO};
  }

  /* ---- Performance Banner ---- */
  .perf-banner {
    margin: 0 0 64px;
    padding: 18px 24px;
    background: linear-gradient(135deg, var(--panel), var(--surface));
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
  }
  .perf-banner-content {
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }
  .perf-badge {
    font-family: 'JetBrains Mono', ${MONO}; font-size: 11px; font-weight: 700; color: #fff;
    background: var(--green-2); padding: 4px 10px; border-radius: 6px; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .perf-banner p { margin: 0; flex-grow: 1; font-size: 15.5px; color: var(--soft); }
  .perf-banner p strong { color: var(--fg); }
  .perf-link { font-size: 14px; font-weight: 700; color: var(--link); display: inline-flex; align-items: center; gap: 4px; transition: color 0.2s; }
  .perf-link:hover { text-decoration: underline; color: var(--green); }

  /* ---- Timeline ---- */
  .timeline-section {
    position: relative;
    padding: 32px 0;
  }
  .timeline {
    position: relative;
    max-width: 1040px;
    margin: 48px auto 0;
  }
  .timeline::before {
    content: "";
    position: absolute;
    left: 20px;
    top: 20px;
    bottom: 20px;
    width: 2px;
    background: var(--line-2);
  }
  .timeline-step {
    position: relative;
    display: grid;
    grid-template-columns: 42px 1fr 1.2fr;
    gap: 48px;
    margin-bottom: 64px;
    align-items: start;
  }
  .timeline-step:last-child {
    margin-bottom: 0;
  }
  .timeline-marker {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--surface);
    border: 2px solid var(--green-2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 13px;
    font-weight: 700;
    color: var(--green);
    box-shadow: 0 0 0 4px var(--bg);
    z-index: 2;
    transition: all 0.25s ease;
  }
  .timeline-step:hover .timeline-marker {
    background: var(--green-2);
    color: #fff;
    box-shadow: 0 0 0 6px var(--green-soft);
    transform: scale(1.1);
  }
  .timeline-info h3 {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 800;
    color: var(--fg);
  }
  .timeline-info code.package-badge {
    display: inline-block;
    margin-bottom: 12px;
    font-size: 11px;
    font-family: 'JetBrains Mono', ${MONO};
    font-weight: 700;
    color: var(--green-2);
    background: var(--green-soft);
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid rgba(99, 102, 241, 0.15);
  }
  .timeline-info p {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--muted);
  }
  .timeline-code {
    margin: 0;
  }
  .timeline-code .code-window { margin: 0; }

  /* ---- code blocks ---- */
  pre.code {
    background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--radius);
    padding: 18px 20px; overflow-x: auto; font-size: 13.5px; line-height: 1.7; margin: 0;
    color: var(--code-fg); box-shadow: var(--shadow);
    max-width: 100%;
    min-width: 0;
  }
  pre.code code {
    display: block;
    min-width: 100%;
    width: max-content;
  }
  pre.code .k { color: var(--code-keyword); }
  pre.code .s { color: var(--code-string); }
  pre.code .c { color: var(--code-comment); font-style: italic; }
  pre.code .l { color: var(--code-literal); }

  /* ---- shared: /benchmarks tables + /docs prose (do not remove) ---- */
  main.wrap { padding-bottom: 48px; }
  h1.page { font-size: clamp(38px, 6vw, 60px); line-height: 1.02; letter-spacing: -0.02em; margin: 60px 0 14px; }
  p.lead { color: var(--muted); font-size: 18px; margin: 0 0 10px; max-width: 780px; }
  .bench h2 { font-size: 22px; margin: 42px 0 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; background: var(--panel); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bench-grid { display: grid; grid-template-columns: 1fr; gap: 28px; margin-top: 20px; }
  .bench-block h2 { font-size: 18px; margin: 0 0 12px; }
  .bench-block table { font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr.hl td { background: var(--green-soft); color: var(--fg); font-weight: 700; }
  .caveat {
    background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--green);
    border-radius: var(--radius); padding: 14px 18px; margin: 22px 0; color: var(--muted); font-size: 14px;
  }
  .caveat b { color: var(--fg); }
  .prose { width: 100%; max-width: 760px; }
  .prose h2 { font-size: 25px; margin: 46px 0 12px; letter-spacing: -0.01em; scroll-margin-top: 88px; }
  .prose h3 { scroll-margin-top: 88px; }
  .prose p, .prose ul { color: var(--soft); font-size: 15px; line-height: 1.72; }
  .prose ul { padding-left: 20px; }
  .prose li { margin: 7px 0; }
  .prose :not(pre) > code { background: var(--green-soft); border: 1px solid rgba(22, 163, 74, 0.18); border-radius: 6px; padding: 1px 6px; font-size: 13px; color: var(--green-2); }
  .docs-shell {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 200px;
    gap: 40px;
    align-items: flex-start;
    padding-top: 40px;
  }
  .docs-side {
    position: sticky;
    top: 96px;
    height: calc(100vh - 120px);
    overflow-y: auto;
    padding-bottom: 24px;
    padding-right: 8px;
  }
  .docs-side::-webkit-scrollbar,
  .docs-toc::-webkit-scrollbar {
    width: 4px;
  }
  .docs-side::-webkit-scrollbar-thumb,
  .docs-toc::-webkit-scrollbar-thumb {
    background: var(--line-2);
    border-radius: 99px;
  }
  .docs-side::-webkit-scrollbar-track,
  .docs-toc::-webkit-scrollbar-track {
    background: transparent;
  }
  .docs-side nav {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .docs-side .nav-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 20px;
  }
  .docs-side .nav-group-title {
    padding: 0 12px 8px;
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    opacity: 0.8;
  }
  .docs-side a {
    display: block;
    color: var(--muted);
    font-size: 13.5px;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid transparent;
    transition: all 0.15s ease;
    margin-left: 0;
  }
  .docs-side a:hover {
    color: var(--fg);
    background: var(--hover);
    text-decoration: none;
  }
  .docs-side a.active {
    color: var(--green-2);
    background: var(--green-soft);
    border-color: rgba(99, 102, 241, 0.15);
    font-weight: 700;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }
  :root[data-theme="dark"] .docs-side a.active {
    background: rgba(99, 102, 241, 0.12);
  }
  .docs-main {
    min-width: 0;
  }
  .docs-main .page {
    margin-top: 24px;
  }

  /* Right TOC Sidebar */
  .docs-toc {
    position: sticky;
    top: 96px;
    height: calc(100vh - 120px);
    overflow-y: auto;
    padding-bottom: 24px;
    border-left: 1px solid var(--line);
    padding-left: 18px;
  }
  .docs-toc .toc-title {
    font-family: "Outfit", sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 12px;
  }
  .docs-toc nav {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .docs-toc a {
    font-size: 13px;
    line-height: 1.4;
    color: var(--muted);
    transition: all 0.15s ease;
    border-left: 2px solid transparent;
    padding-left: 8px;
    margin-left: -10px;
    display: block;
  }
  .docs-toc a:hover {
    color: var(--fg);
    text-decoration: none;
  }
  .docs-toc a.active {
    color: var(--green-2);
    font-weight: 600;
    border-left-color: var(--green-2);
  }

  /* Search input container */
  .docs-search-container {
    margin-bottom: 16px;
    padding: 0 12px;
  }
  .docs-search-container input {
    width: 100%;
    padding: 8px 12px 8px 32px;
    font-size: 13px;
    border-radius: 8px;
    border: 1px solid var(--line-2);
    background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2364748b' stroke-width='2'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'/%3E%3C/svg%3E") no-repeat 10px center;
    background-size: 14px 14px;
    color: var(--fg);
    outline: none;
    transition: all 0.15s ease;
  }
  .docs-search-container input:focus {
    border-color: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
  }

  /* MacOS-Style Code Windows */
  .code-window {
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    border-radius: var(--radius);
    overflow: hidden;
    margin: 24px 0;
    box-shadow: var(--shadow);
  }
  .code-window-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .code-window-dots {
    display: flex;
    gap: 6px;
  }
  .code-window-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .code-window-dot.red { background: #ff5f56; }
  .code-window-dot.yellow { background: #ffbd2e; }
  .code-window-dot.green { background: #27c93f; }
  .code-window-lang {
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .code-window pre.code {
    border: none;
    border-radius: 0;
    border-left: none;
    box-shadow: none;
    padding: 16px 20px;
    margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  }

  /* ---- responsive ---- */
  @media (max-width: 960px) {
    .feature-showcase { grid-template-columns: 1fr; gap: 32px; margin: 48px 0; }
    .feature-showcase.reverse { grid-template-columns: 1fr; }
    .feature-showcase.reverse .feature-info { order: 1; }
    .feature-showcase.reverse .code-window { order: 2; }
    .hero { grid-template-columns: 1fr; gap: 34px; padding: 64px 0 56px; }
    .hero-copy { align-items: center; text-align: center; max-width: 820px; margin: 0 auto; gap: 24px; }
    .hero-actions { justify-content: center; }
    .proof { grid-template-columns: repeat(2, 1fr); margin-bottom: 76px; }
    .proof-item:nth-child(2) { border-right: none; }
    .proof-item:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
    .timeline::before { left: 20px; }
    .timeline-step { grid-template-columns: 42px 1fr; gap: 16px; margin-bottom: 48px; }
    .timeline-code { grid-column: 2; margin-top: 12px; }
    .mult-grid { grid-template-columns: repeat(2, 1fr); }
    .bench-duo { grid-template-columns: 1fr; }
    .runtime-strip { grid-template-columns: 1fr; }
    .docs-shell { flex-direction: column; align-items: stretch; gap: 0; }
    .docs-side { position: static; flex-basis: auto; padding-top: 28px; width: 100%; }
    .docs-main { width: 100%; }
    .docs-side nav { flex-direction: row; flex-wrap: wrap; border-left: none; gap: 4px; }
    .docs-side .nav-group { width: 100%; flex-direction: row; flex-wrap: wrap; gap: 4px; }
    .docs-side .nav-group + .nav-group { margin-top: 8px; }
    .docs-side .nav-group-title { width: 100%; padding: 8px 0 2px; }
    .docs-side a { border: 1px solid var(--line); border-radius: 7px; margin-left: 0; }
  }

  @media (max-width: 620px) {
    .wrap { width: min(calc(100% - 28px), 1140px); }
    header.site .wrap { height: auto; min-height: 60px; padding: 10px 0; flex-direction: column; align-items: flex-start; gap: 8px; }
    nav.top { width: 100%; flex-wrap: wrap; overflow-x: visible; padding-bottom: 2px; }
    nav.top a { padding-left: 0; padding-right: 12px; white-space: nowrap; }
    .hero { padding-top: 36px; padding-bottom: 38px; gap: 0; }
    .hero .hero-actions {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: stretch; width: min(100%, 340px);
    }
    .hero .install-widget { grid-column: 1 / -1; width: 100%; justify-content: center; }
    .hero .hero-actions .button { width: 100%; min-width: 0; justify-content: center; padding: 0 12px; }
    .hero-fineprint, .agent-board { display: none; }
    .cta .hero-actions { flex-direction: column; align-items: center; }
    .cta .install-widget, .cta .hero-actions .button { width: min(100%, 340px); justify-content: center; }
    .proof, .feature-grid { grid-template-columns: 1fr; }
    .proof-item, .proof-item:nth-child(2) { border-right: none; border-bottom: 1px solid var(--line); }
    .proof-item:last-child { border-bottom: none; }
    .section { margin-bottom: 72px; }
    .cta { padding: 40px 22px; }
    .bar-row { grid-template-columns: 76px 1fr 64px; gap: 10px; }
    table { font-size: 12px; }
    th, td { padding: 10px; }
    footer.site .wrap { flex-direction: column; }
    .play-grid { grid-template-columns: 1fr; }
  }

  /* ---- /play playground — editor-first: code full-width on top, requests + response paired below ---- */
  .play-head { max-width: 760px; margin-bottom: 22px; }

  /* Sticky controls bar (presets + Run) — never lost under an editor, always reachable. */
  .play-controls {
    position: sticky; top: 64px; z-index: 6;
    display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
    margin-bottom: 16px; padding: 12px 14px;
    background: var(--header-bg); backdrop-filter: blur(10px);
    border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow);
  }
  .play-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .play-presets-label { font-size: 13px; color: var(--muted); }
  .play-preset {
    font-family: ${MONO}; font-size: 12px; font-weight: 600; color: var(--soft);
    background: var(--panel); border: 1px solid var(--line-2); border-radius: 99px;
    padding: 5px 12px; cursor: pointer; transition: border-color .15s, color .15s, background .15s;
  }
  .play-preset:hover { color: var(--fg); border-color: var(--green); }
  .play-segment {
    display: inline-flex; gap: 4px; margin: 0; padding: 4px; min-inline-size: 0;
    background: var(--panel); border: 1px solid var(--line-2); border-radius: 99px;
  }
  .play-segment .play-preset { border: 1px solid transparent; background: transparent; }
  .play-segment .play-preset:hover { color: var(--fg); border-color: transparent; background: var(--hover); }
  .play-preset.active, .play-segment .play-preset.active:hover {
    color: #fff; border-color: transparent;
    background: linear-gradient(135deg, var(--green-2), var(--green));
  }
  .play-run-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .play-run { min-height: 40px; }
  .play-kbd-hint { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
  .play-kbd {
    font-family: ${MONO}; font-size: 11px; color: var(--soft);
    background: var(--surface); border: 1px solid var(--line-2); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 6px; min-width: 18px; text-align: center; line-height: 1.5;
  }

  .play-grid {
    display: grid;
    grid-template-columns: 2fr 3fr;
    grid-template-areas: "code code" "requests results";
    gap: 16px; align-items: stretch;
  }
  .play-pane--code { grid-area: code; }
  .play-pane--requests { grid-area: requests; }
  .play-pane--results { grid-area: results; }
  .play-pane {
    display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
  }
  /* Pair the input + output panes with a shared accent edge. */
  .play-pane--requests, .play-pane--results { border-color: var(--line-2); }
  .play-pane-head {
    display: flex; align-items: center; gap: 9px; flex: 0 0 auto;
    padding: 9px 14px; background: var(--panel-2); border-bottom: 1px solid var(--line);
  }
  .play-window-title { font-family: ${MONO}; font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.02em; }
  .play-pane-hint { font-family: ${MONO}; font-size: 10.5px; color: var(--muted); opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .play-lang-badge {
    margin-left: auto; font-family: ${MONO}; font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em;
    color: var(--green-2); background: var(--green-soft); border: 1px solid rgba(99, 102, 241, 0.18);
    border-radius: 5px; padding: 1px 6px;
  }
  .play-live-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); margin-left: auto; }
  .play-editor {
    flex: 1 1 auto; width: 100%; box-sizing: border-box; resize: none; tab-size: 2;
    font-family: ${MONO}; font-size: 13.5px; line-height: 1.6; color: var(--fg);
    background: var(--code-bg); border: 0; border-radius: 0; padding: 14px; outline: none;
  }
  .play-editor:focus { box-shadow: inset 0 0 0 2px var(--green); }
  .play-editor::selection { background: var(--green-soft); }
  .play-editor-code { min-height: clamp(220px, 42vh, 460px); }
  .play-editor-requests { min-height: clamp(170px, 30vh, 340px); }
  .play-results {
    display: flex; flex-direction: column; gap: 10px; padding: 14px; overflow: auto;
    min-height: clamp(170px, 30vh, 340px);
  }
  .play-running { color: var(--muted); font-family: ${MONO}; font-size: 13px; padding: 6px 2px; }
  .play-card { border: 1px solid var(--line-2); border-radius: var(--radius); overflow: hidden; }
  .play-card-head {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    background: var(--panel-2); border-bottom: 1px solid var(--line);
  }
  .play-method { font-family: ${MONO}; font-size: 11px; font-weight: 700; color: var(--green-2); }
  .play-path { font-family: ${MONO}; font-size: 12px; color: var(--soft); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .play-badge { font-family: ${MONO}; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 99px; }
  .play-badge-ok { color: #0369a1; background: var(--green-soft); }
  .play-badge-warn { color: #b45309; background: rgba(180, 83, 9, 0.12); }
  .play-badge-err { color: #b91c1c; background: rgba(185, 28, 28, 0.12); }
  .play-body { margin: 0; padding: 12px; font-family: ${MONO}; font-size: 12.5px; line-height: 1.5; color: var(--fg); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  .play-body-err { color: #b91c1c; }
  .play-noscript { color: var(--muted); margin-top: 16px; }

  @media (max-width: 1024px) {
    .play-grid { grid-template-columns: 1fr; grid-template-areas: "code" "requests" "results"; }
  }
  @media (max-width: 640px) {
    .play-controls { position: static; }
    .play-editor-code { min-height: 200px; }
    .play-editor-requests, .play-results { min-height: 160px; }
  }

  /* ---- nifra bot island ---- */
  .nifra-bot-container {
    position: fixed;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 14px;
    pointer-events: none;
    user-select: none;
    touch-action: none;
    max-width: min(360px, calc(100vw - 28px));
  }
  .nifra-bot-container:not(.dragging) {
    transition: left 0.3s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .nifra-bot-panel {
    pointer-events: auto;
    width: min(350px, calc(100vw - 28px));
    max-height: min(520px, calc(100vh - 128px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--line-2);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface) 94%, var(--panel) 6%);
    color: var(--fg);
    box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18), var(--shadow);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }
  :root[data-theme="dark"] .nifra-bot-panel {
    background: color-mix(in srgb, var(--surface) 88%, var(--ink) 12%);
    box-shadow: 0 24px 58px rgba(0, 0, 0, 0.46);
  }
  .nifra-bot-container[data-open="false"] .nifra-bot-panel {
    display: none;
  }
  .nifra-bot-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 10px 14px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(135deg, var(--panel), var(--surface));
  }
  .nifra-bot-panel-head strong {
    display: block;
    margin: 0;
    font-family: "Outfit", "Inter", sans-serif;
    font-size: 15px;
    line-height: 1.15;
  }
  .nifra-bot-panel-head span {
    display: block;
    margin-top: 3px;
    color: var(--green-2);
    font-family: "JetBrains Mono", ${MONO};
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .nifra-bot-close {
    width: 30px;
    height: 30px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
  }
  .nifra-bot-close:hover,
  .nifra-bot-close:focus-visible {
    color: var(--fg);
    border-color: var(--green);
    outline: none;
  }
  .nifra-bot-messages {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 116px;
    max-height: 260px;
    overflow-y: auto;
    padding: 12px;
    overscroll-behavior: contain;
  }
  .nifra-bot-message {
    max-width: 92%;
    margin: 0;
    padding: 9px 11px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .nifra-bot-message.bot {
    align-self: flex-start;
    color: var(--fg);
    background: var(--panel);
    border: 1px solid var(--line);
  }
  .nifra-bot-message.user {
    align-self: flex-end;
    color: #fff;
    background: linear-gradient(135deg, var(--green-2), var(--green));
  }
  .nifra-bot-message.bot.thinking {
    font-family: "JetBrains Mono", ${MONO};
    font-size: 11px;
    color: var(--green);
    background: rgba(34, 211, 238, 0.05);
    border-color: rgba(34, 211, 238, 0.3);
    white-space: pre-wrap;
    text-shadow: 0 0 2px rgba(34, 211, 238, 0.4);
    box-shadow: inset 0 0 10px rgba(34, 211, 238, 0.05);
  }
  :root[data-theme="light"] .nifra-bot-message.bot.thinking {
    color: var(--green-2);
    background: rgba(99, 102, 241, 0.03);
    border-color: rgba(99, 102, 241, 0.25);
    text-shadow: none;
    box-shadow: none;
  }
  .nifra-bot-message pre.code {
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    border-left: 3px solid var(--green-2);
    border-radius: 6px;
    padding: 8px 10px;
    overflow-x: auto;
    font-size: 11.5px;
    line-height: 1.45;
    margin: 8px 0 0;
    color: var(--code-fg);
  }
  .nifra-bot-message code.inline {
    font-family: "JetBrains Mono", ${MONO};
    color: var(--green-2);
    background: var(--green-soft);
    border: 1px solid rgba(99, 102, 241, 0.15);
    border-radius: 4px;
    padding: 1px 4px;
    font-size: 0.9em;
  }
  .nifra-bot-quick {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    min-inline-size: 0;
    margin: 0;
    padding: 0 12px 12px;
    border: 0;
  }
  .nifra-bot-quick button {
    min-height: 30px;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--surface);
    color: var(--soft);
    cursor: pointer;
    font-family: "JetBrains Mono", ${MONO};
    font-size: 11px;
    font-weight: 700;
    padding: 0 9px;
  }
  .nifra-bot-quick button:hover,
  .nifra-bot-quick button:focus-visible {
    border-color: var(--green);
    color: var(--fg);
    outline: none;
  }
  .nifra-bot-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .nifra-bot-form input {
    min-width: 0;
    height: 38px;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--surface);
    color: var(--fg);
    padding: 0 11px;
    font-size: 13px;
  }
  .nifra-bot-form input:focus {
    border-color: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
    outline: none;
  }
  .nifra-bot-form button {
    height: 38px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--fg);
    color: var(--bg);
    cursor: pointer;
    font-size: 12px;
    font-weight: 800;
    padding: 0 12px;
  }
  .nifra-bot-form button:hover,
  .nifra-bot-form button:focus-visible {
    background: var(--green-2);
    color: #fff;
    outline: none;
  }
  .nifra-bot-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  .nifra-bubble-container {
    display: none;
    position: relative;
    /* Promote to its own compositor layer so scrolling the page behind the tip never repaints it. */
    will-change: transform;
  }
  .nifra-bubble-container.visible {
    display: block;
  }
  .nifra-bubble {
    pointer-events: auto;
    /* Opaque (no backdrop-filter): a live blur re-samples the scrolling backdrop every frame — the
       real remaining scroll cost. box-shadow composites without re-rasterizing like filter does. */
    background: #0b0f19;
    color: #f3f4f6;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 12px 16px;
    border-radius: 14px;
    font-size: 13.5px;
    line-height: 1.45;
    max-width: 250px;
    text-align: center;
    word-wrap: break-word;
    cursor: pointer;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28), inset 0 1px 1px rgba(255, 255, 255, 0.08);
  }
  :root[data-theme="light"] .nifra-bubble {
    background: #ffffff;
    color: #0f172a;
    border-color: rgba(15, 23, 42, 0.1);
    box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14), inset 0 1px 1px rgba(255, 255, 255, 0.6);
  }
  .nifra-bubble-container.visible .nifra-bubble {
    opacity: 1;
    transform: translateY(0);
  }
  .nifra-bubble::after {
    content: "";
    position: absolute;
    bottom: -6px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid rgba(11, 15, 25, 0.95);
  }
  :root[data-theme="light"] .nifra-bubble::after {
    border-top-color: rgba(255, 255, 255, 0.95);
  }

  .nifra-bot {
    position: relative;
    display: block;
    pointer-events: auto;
    width: 76px;
    height: 76px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 24px;
    cursor: grab;
    background: transparent;
    box-shadow: none;
    transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), filter 0.2s ease;
    animation: bot-float 4s ease-in-out infinite;
    appearance: none;
    padding: 0;
  }
  .nifra-bot-avatar {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
    filter: drop-shadow(0 14px 22px rgba(15, 23, 42, 0.28))
      drop-shadow(0 0 14px rgba(34, 211, 238, 0.22));
  }
  :root[data-theme="dark"] .nifra-bot-avatar {
    filter: drop-shadow(0 18px 24px rgba(0, 0, 0, 0.48))
      drop-shadow(0 0 18px rgba(34, 211, 238, 0.34));
  }
  .nifra-bot-container.dragging .nifra-bot {
    cursor: grabbing;
    transform: scale(1.08);
  }
  .nifra-bot:hover,
  .nifra-bot:focus-visible {
    transform: scale(1.05);
    outline: none;
  }

  @keyframes bot-float {
    0% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
    100% { transform: translateY(0); }
  }

  /* ---- features ecosystem grid ---- */
  .ecosystem-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    margin-top: 36px;
  }
  .ecosystem-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 22px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .ecosystem-card:hover {
    transform: translateY(-4px);
    border-color: var(--green);
    box-shadow: 0 12px 28px rgba(6, 182, 212, 0.08);
  }
  .ecosystem-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .ecosystem-pkg {
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 11.5px;
    font-weight: 700;
    color: var(--green-2);
  }
  .ecosystem-badge {
    font-size: 9px;
    font-weight: 700;
    color: var(--muted);
    border: 1px solid var(--line-2);
    background: var(--panel);
    border-radius: 99px;
    padding: 1px 7px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .ecosystem-card h3 {
    margin: 0 0 6px;
    font-size: 17px;
    font-weight: 800;
    color: var(--fg);
  }
  .ecosystem-card p {
    margin: 0 0 16px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--soft);
    flex-grow: 1;
  }
  .ecosystem-card pre.code {
    padding: 12px 14px;
    font-size: 11px;
    line-height: 1.5;
    border-radius: var(--radius);
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    margin: 0;
  }
  .ecosystem-card:hover pre.code { border-color: var(--line-2); }

  @media (max-width: 960px) {
    .ecosystem-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 620px) {
    .ecosystem-grid {
      grid-template-columns: 1fr;
    }
    .nifra-bot-container {
      bottom: 16px;
      right: 16px;
      max-width: calc(100vw - 24px);
    }
    .nifra-bot-panel {
      width: calc(100vw - 24px);
      max-height: calc(100vh - 112px);
    }
  }

  /* ---- Modern Docs Overhaul & Agentic styling ---- */
  .docs-topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0 20px;
    margin-bottom: 24px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
    gap: 12px;
  }
  .docs-breadcrumbs {
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 13px;
    color: var(--muted);
  }
  .docs-breadcrumbs .crumb-sec {
    color: var(--muted);
  }
  .docs-breadcrumbs .crumb-sep {
    color: var(--line-2);
    margin: 0 6px;
  }
  .docs-breadcrumbs .crumb-active {
    color: var(--fg);
    font-weight: 700;
  }
  .feed-agent-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--green-soft);
    border: 1px solid rgba(22, 163, 74, 0.22);
    color: var(--green-2);
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .feed-agent-btn:hover {
    background: var(--green-2);
    color: #fff;
    border-color: var(--green-2);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.15);
  }
  .feed-agent-btn.copied {
    background: var(--green);
    color: #fff;
    border-color: var(--green);
  }
  .feed-agent-btn svg {
    flex-shrink: 0;
  }

  /* Code block copy button */
  .code-copy-btn {
    position: absolute;
    top: 10px;
    right: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--line-2);
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease, border-color 0.15s, color 0.15s;
    z-index: 10;
  }
  pre.code:hover .code-copy-btn {
    opacity: 1;
  }
  .code-copy-btn:hover {
    color: var(--fg);
    border-color: var(--green);
  }
  .code-copy-btn svg.copy-icon {
    width: 14px;
    height: 14px;
  }
  .code-copy-btn .copied-toast {
    display: none;
    position: absolute;
    right: 36px;
    background: var(--fg);
    color: var(--bg);
    font-family: 'JetBrains Mono', ${MONO};
    font-size: 10px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
    box-shadow: var(--shadow);
  }
  .code-copy-btn.copied .copied-toast {
    display: block;
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateX(4px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* GitHub Alert callouts */
  .alert-callout {
    padding: 16px;
    margin: 24px 0;
    border-radius: 8px;
    border-left: 4px solid var(--line);
    font-size: 14.5px;
    line-height: 1.6;
  }
  .alert-callout.note {
    background: rgba(99, 102, 241, 0.05);
    border-left-color: var(--green-2);
  }
  .alert-callout.tip {
    background: rgba(34, 211, 238, 0.05);
    border-left-color: var(--green);
  }
  .alert-callout.warning {
    background: rgba(217, 119, 6, 0.05);
    border-left-color: var(--amber);
  }
  .alert-callout.caution {
    background: rgba(239, 68, 68, 0.05);
    border-left-color: #ef4444;
  }
  .alert-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    margin-bottom: 8px;
  }
  .alert-head svg.alert-icon {
    width: 16px;
    height: 16px;
  }
  .alert-callout.note .alert-head { color: var(--green-2); }
  .alert-callout.tip .alert-head { color: var(--green); }
  .alert-callout.warning .alert-head { color: var(--amber); }
  .alert-callout.caution .alert-head { color: #ef4444; }
  .alert-body p:last-child {
    margin-bottom: 0;
  }

  /* Responsive styles for docs layout */
  @media (max-width: 1200px) {
    .docs-shell {
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 30px;
    }
    .docs-toc {
      display: none;
    }
  }

  @media (max-width: 800px) {
    .docs-shell {
      grid-template-columns: 1fr;
      gap: 16px;
      padding-top: 16px;
    }
    .docs-side {
      position: static;
      height: auto;
      padding-top: 12px;
      width: 100%;
      overflow-y: visible;
      border-bottom: 1px solid var(--line);
      padding-bottom: 16px;
      padding-right: 0;
    }
    .docs-side nav {
      flex-direction: row;
      flex-wrap: wrap;
      gap: 8px;
    }
    .docs-side .nav-group {
      width: 100%;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .docs-side .nav-group-title {
      width: 100%;
      padding: 4px 0;
    }
    .docs-side a {
      border: 1px solid var(--line);
    }
    .docs-search-container {
      width: 100%;
      padding: 0;
    }
  }

  /* ===================== Homepage overhaul + polish ===================== */

  /* Hero headline accent — gradient text */
  .hero h1 em {
    background: linear-gradient(120deg, var(--green-2), var(--green));
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
  }

  /* Hero value row — lead with the "why" (3 value props) before the dense feature sections. */
  .value-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 0 0 56px; }
  .value-item {
    padding: 20px 22px; border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow);
    transition: transform .2s cubic-bezier(0.4, 0, 0.2, 1), border-color .2s ease;
  }
  .value-item:hover { transform: translateY(-3px); border-color: var(--green); }
  .value-item strong { display: block; font-family: "Outfit", sans-serif; font-size: 16px; font-weight: 800; color: var(--fg); margin-bottom: 7px; }
  .value-item span { display: block; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
  @media (max-width: 760px) { .value-row { grid-template-columns: 1fr; } }

  /* Framework switcher — CSS-only (:checked radio tabs, zero JS) */
  .fw-switcher { width: 100%; min-width: 0; }
  .fw-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .fw-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .fw-tab {
    font-family: "JetBrains Mono", ${MONO}; font-size: 12px; font-weight: 700;
    color: var(--soft); background: var(--panel); border: 1px solid var(--line-2);
    border-radius: 99px; padding: 6px 14px; cursor: pointer;
    transition: color .15s ease, border-color .15s ease, background .15s ease, box-shadow .15s ease;
  }
  .fw-tab:hover { color: var(--fg); border-color: var(--green); }
  .fw-panel { display: none; }
  .fw-panel .code-window { margin: 0; }
  #fw-react:checked ~ .fw-tabs .fw-tab[for="fw-react"],
  #fw-solid:checked ~ .fw-tabs .fw-tab[for="fw-solid"],
  #fw-vue:checked ~ .fw-tabs .fw-tab[for="fw-vue"],
  #fw-preact:checked ~ .fw-tabs .fw-tab[for="fw-preact"],
  #fw-svelte:checked ~ .fw-tabs .fw-tab[for="fw-svelte"] {
    color: #fff; border-color: transparent;
    background: linear-gradient(135deg, var(--green-2), var(--green));
    box-shadow: 0 6px 16px rgba(99, 102, 241, 0.22);
  }
  #fw-react:checked ~ .fw-panels .fw-panel-react,
  #fw-solid:checked ~ .fw-panels .fw-panel-solid,
  #fw-vue:checked ~ .fw-panels .fw-panel-vue,
  #fw-preact:checked ~ .fw-panels .fw-panel-preact,
  #fw-svelte:checked ~ .fw-panels .fw-panel-svelte { display: block; }
  .fw-radio:focus-visible ~ .fw-tabs .fw-tab,
  .fw-tab:focus-visible { outline: 2px solid var(--green-2); outline-offset: 2px; }

  /* Runtime target grid */
  .runtime-section { margin-top: -40px; }
  .runtime-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
  .runtime-tile {
    display: flex; flex-direction: column; gap: 5px; padding: 18px 16px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow);
    transition: transform .2s cubic-bezier(0.4, 0, 0.2, 1), border-color .2s ease;
  }
  .runtime-tile:hover { transform: translateY(-3px); border-color: var(--green); box-shadow: 0 12px 28px rgba(6, 182, 212, 0.08); }
  .runtime-tile-name { font-family: "Outfit", sans-serif; font-size: 17px; font-weight: 800; color: var(--fg); }
  .runtime-tile-note { font-size: 12.5px; color: var(--muted); }
  .runtime-tile-code {
    margin-top: 7px; font-family: "JetBrains Mono", ${MONO}; font-size: 10.5px; line-height: 1.4;
    color: var(--green-2); background: var(--green-soft); border: 1px solid rgba(99, 102, 241, 0.15);
    border-radius: 6px; padding: 6px 8px; overflow-x: auto; white-space: nowrap;
  }

  /* Single source of truth — schema fan diagram */
  .source-fan {
    display: grid; grid-template-columns: 200px 1fr; gap: 28px; align-items: center;
    max-width: 980px; margin: 0 auto 56px; padding: 24px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: linear-gradient(135deg, var(--panel), var(--surface)); box-shadow: var(--shadow);
  }
  .source-core {
    display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
    padding: 24px 16px; border: 1px solid var(--green); border-radius: var(--radius);
    background: var(--green-soft);
  }
  .source-core code { font-family: "JetBrains Mono", ${MONO}; font-size: 15px; font-weight: 700; color: var(--green-2); }
  .source-core span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 700; }
  .source-outputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .source-output {
    padding: 12px 14px; border: 1px solid var(--line); border-left: 3px solid var(--green-2);
    border-radius: 8px; background: var(--surface);
  }
  .source-output strong { display: block; font-size: 13.5px; color: var(--fg); }
  .source-output span { display: block; margin-top: 3px; font-size: 12px; color: var(--muted); line-height: 1.4; }

  /* Closing CTA band */
  .cta {
    text-align: center; max-width: 820px; margin: 8px auto 80px; padding: 56px 40px;
    border: 1px solid var(--line); border-radius: 24px;
    background: radial-gradient(circle at 50% 0%, var(--green-soft), transparent 70%), var(--surface);
    box-shadow: var(--shadow);
  }
  .cta .kicker { margin-bottom: 12px; }
  .cta h2 { margin: 0; font-size: clamp(28px, 4vw, 42px); line-height: 1.1; letter-spacing: -0.025em; font-weight: 800; }
  .cta p { margin: 16px auto 28px; max-width: 560px; color: var(--muted); font-size: 16.5px; line-height: 1.6; }
  .cta .hero-actions { justify-content: center; }

  /* Nira: tip-change pop so a scrolled tip is noticeable */
  .nifra-bubble.pulse { animation: tip-pop 0.34s cubic-bezier(0.2, 0.8, 0.2, 1); }
  @keyframes tip-pop {
    0% { transform: translateY(0) scale(0.96); }
    55% { transform: translateY(-2px) scale(1.03); }
    100% { transform: translateY(0) scale(1); }
  }

  /* Docs: collapse the right "On this page" column when a page has no headings */
  .docs-shell.no-toc { grid-template-columns: 240px minmax(0, 1fr); }
  .docs-shell.no-toc .docs-toc { display: none; }

  /* Responsive — new homepage blocks */
  @media (max-width: 960px) {
    .runtime-section { margin-top: 0; }
    .runtime-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .source-fan { grid-template-columns: 1fr; gap: 18px; }
  }
  @media (max-width: 620px) {
    .runtime-grid { grid-template-columns: 1fr; }
    .cta { padding: 40px 22px; }
  }
`.trim()

// No-FOUC theme init + delegated toggle. The IIFE sets `data-theme` on <html> before the body paints
// (reads localStorage, falls back to the OS preference); the delegated click handler flips + persists it.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('nifra-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('#theme-toggle');if(!b)return;var n=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('nifra-theme',n);}catch(e){}});`

export default function Layout(props: { children?: ReactNode }) {
  return (
    <div id="app">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap"
        rel="stylesheet"
      />
      <div className="site-atmosphere" aria-hidden="true" />
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, static, build-time theme bootstrap. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <style>{css}</style>
      <header className="site">
        <div className="wrap">
          <a href="/" className="logo" aria-label="Nifra home" rel="external">
            <img className="logo-mark" src="/assets/logo-mark.png" alt="" width={48} height={48} />
            Nifra
            <span className="logo-badge">Built in Nifra</span>
          </a>
          <nav className="top" aria-label="Primary navigation">
            <a href="/docs">Docs</a>
            <a href="/play">Playground</a>
            <a href="/benchmarks">Benchmarks</a>
            <a href="/docs/security">Security</a>
            <a href="/docs/frameworks">Frameworks</a>
            <button
              id="theme-toggle"
              className="theme-toggle"
              type="button"
              aria-label="Toggle dark mode"
            >
              <svg
                className="sun"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
              <svg
                className="moon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            </button>
          </nav>
        </div>
      </header>
      <main className="wrap">{props.children}</main>
      <footer className="site">
        <div className="wrap">
          <span>Proudly built with Nifra — server-rendered on Cloudflare Pages.</span>
          <span>MIT</span>
        </div>
      </footer>

      <script type="module" src="/assets/nifra-bot.client.js?v=4" />
    </div>
  )
}
