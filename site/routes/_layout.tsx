import type { ReactNode } from "react"
import fonts from "../shared/data/fonts.json"

// The hero demo plays once on load and again on Replay. A CSS animation only restarts when its name
// changes, so the two autoplay radios get identical rules under different keyframe names.
const demoAutoplay = (id: string, k: string): string => `
  #${id}:checked ~ .demo-screen .demo-frame {
    animation: demo-frame-${k} var(--demo-step) linear calc(var(--n) * var(--demo-step)) forwards;
  }
  #${id}:checked ~ .demo-screen .demo-frame[data-step="4"] { animation-name: demo-hold-${k}; }
  #${id}:checked ~ .demo-screen .demo-line {
    animation: demo-line-${k} 0.32s ease-out calc(var(--n) * var(--demo-step) + 0.3s + var(--i) * 0.11s) both;
  }
  #${id}:checked ~ .demo-steps .demo-step::after {
    animation: demo-fill-${k} var(--demo-step) linear calc(var(--n) * var(--demo-step)) forwards;
  }
  @keyframes demo-frame-${k} {
    0% { opacity: 0; visibility: visible; }
    5%, 95% { opacity: 1; visibility: visible; }
    100% { opacity: 0; visibility: hidden; }
  }
  @keyframes demo-hold-${k} {
    0% { opacity: 0; visibility: visible; }
    5%, 100% { opacity: 1; visibility: visible; }
  }
  @keyframes demo-line-${k} { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes demo-fill-${k} { from { opacity: 1; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } }
`

// Choosing a step by hand shows that frame and stops the timed run.
const demoManual = [1, 2, 3, 4]
  .map(
    (n) => `
  #demo-${n}:checked ~ .demo-screen .demo-frame[data-step="${n}"] { opacity: 1; visibility: visible; }
  #demo-${n}:checked ~ .demo-screen .demo-frame[data-step="${n}"] .demo-line {
    animation: demo-line-m 0.28s ease-out calc(var(--i) * 0.04s) both;
  }
  #demo-${n}:checked ~ .demo-steps .demo-step[data-step="${n}"] { color: var(--color-graphite-ink); }
  #demo-${n}:checked ~ .demo-steps .demo-step[data-step="${n}"]::after { opacity: 1; }
  #demo-${n}:focus-visible ~ .demo-steps .demo-step[data-step="${n}"] {
    outline: 2px solid var(--color-graphite-accent); outline-offset: -2px;
  }`,
  )
  .join("")

// The home page's framework tabs: one checked radio shows one panel. Keys match FW_TABS in index.tsx.
const homeFwRules = ["react", "solid", "vue", "preact", "svelte"]
  .map(
    (key) => `
  #home-fw-${key}:checked ~ .home-fw-panels .home-fw-panel[data-fw="${key}"] { display: block; }
  #home-fw-${key}:checked ~ .home-fw-tabs label[for="home-fw-${key}"] {
    color: var(--fg); border-bottom-color: var(--color-accent);
  }
  #home-fw-${key}:focus-visible ~ .home-fw-tabs label[for="home-fw-${key}"] {
    outline: 2px solid var(--color-focus); outline-offset: -2px;
  }`,
  )
  .join("")

const css = `
  :root {
    color-scheme: light;
    /* surfaces */
    --color-paper: oklch(98.4% 0.003 248);
    --color-paper-2: oklch(96.8% 0.007 248);
    --color-paper-3: oklch(92.9% 0.013 255);
    --color-surface: oklch(100% 0 0);
    /* ink */
    --color-ink: oklch(20.8% 0.042 266);
    --color-ink-2: oklch(37.2% 0.044 257);
    --color-ink-3: oklch(50% 0.045 257);
    /* rules */
    --color-rule: oklch(92.9% 0.013 255);
    --color-rule-2: oklch(86.9% 0.022 253);
    /* accent: indigo, paired with cyan in the gradient that marks the primary action */
    --color-accent: oklch(58.5% 0.233 277);
    --color-accent-ink: oklch(51.1% 0.262 277);
    --color-accent-hover: oklch(45.7% 0.24 277);
    --color-accent-soft: oklch(96.2% 0.018 272);
    --color-accent-2: oklch(71.5% 0.143 215);
    --color-accent-2-ink: oklch(52% 0.105 223);
    --color-on-accent: oklch(100% 0 0);
    --color-focus: oklch(58.5% 0.233 277);
    --color-ok: oklch(52% 0.13 155);
    --color-warn: oklch(55% 0.13 70);
    --color-danger: oklch(53% 0.19 25);
    --color-shadow: oklch(20.8% 0.042 266);
    /* graphite: code windows and the one dark band. A code window is deep navy in both themes. */
    --color-graphite: oklch(14.5% 0.025 265);
    --color-graphite-2: oklch(18.5% 0.03 265);
    --color-graphite-rule: oklch(25% 0.033 262);
    --color-graphite-ink: oklch(92.8% 0.006 265);
    --color-graphite-muted: oklch(70.7% 0.022 261);
    --color-graphite-accent: oklch(70.2% 0.183 294);
    --color-graphite-accent-2: oklch(78.9% 0.154 212);
    --color-graphite-ok: oklch(76.5% 0.177 163);
    --color-graphite-danger: oklch(71.2% 0.194 13);
    --color-graphite-warn: oklch(82.8% 0.189 84);
    --color-band: oklch(13% 0.028 262);
    --color-code-keyword: oklch(71.8% 0.202 350);
    --color-code-string: oklch(76.5% 0.177 163);
    --color-code-comment: oklch(61% 0.027 264);
    --color-code-literal: oklch(70.7% 0.165 255);
    /* window controls */
    --color-dot-close: oklch(69.5% 0.2 27);
    --color-dot-min: oklch(84% 0.16 80);
    --color-dot-max: oklch(73% 0.2 145);
    /* type */
    --font-display: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif;
    --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    /* shape and depth */
    --radius: 10px;
    --radius-lg: 14px;
    --shadow:
      0 1px 2px color-mix(in oklch, var(--color-shadow) 5%, transparent),
      0 14px 34px -10px color-mix(in oklch, var(--color-shadow) 12%, transparent);
    --shadow-lg:
      0 2px 4px color-mix(in oklch, var(--color-shadow) 6%, transparent),
      0 36px 72px -24px color-mix(in oklch, var(--color-shadow) 34%, transparent);
    --glow: 0 0 110px -28px color-mix(in oklch, var(--color-accent) 42%, transparent);
    --edge: color-mix(in oklch, var(--color-graphite-ink) 8%, transparent);
    --gradient-accent: linear-gradient(135deg, var(--color-accent-ink), var(--color-accent-2-ink));
    --gradient-text: linear-gradient(120deg, var(--color-accent-ink) 5%, var(--color-accent-2-ink) 95%);
    --atmo-veil-top: 74%;
    --atmo-veil-bottom: 96%;
    --atmo-glow: 16%;

    /* Short names the docs, playground, benchmark and framework pages are written against. Each one
       resolves through a --color-* token, so the dark block below only has to restate those. */
    --bg: var(--color-paper);
    --fg: var(--color-ink);
    --muted: var(--color-ink-3);
    --soft: var(--color-ink-2);
    --line: var(--color-rule);
    --line-2: var(--color-rule-2);
    --panel: var(--color-paper-2);
    --panel-2: var(--color-paper-3);
    --surface: var(--color-surface);
    --header-bg: var(--color-paper);
    --hover: color-mix(in oklch, var(--color-ink) 6%, transparent);
    --bar-fill: var(--color-rule-2);
    --green: var(--color-accent);
    --green-2: var(--color-accent-ink);
    --green-soft: var(--color-accent-soft);
    --amber: var(--color-warn);
    --link: var(--color-accent-ink);
    --ink: var(--color-graphite);
    --code-bg: var(--color-graphite);
    --code-fg: var(--color-graphite-ink);
    --code-border: var(--color-graphite-rule);
    --code-keyword: var(--color-code-keyword);
    --code-string: var(--color-code-string);
    --code-comment: var(--color-code-comment);
    --code-literal: var(--color-code-literal);
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --color-paper: oklch(13% 0.028 262);
    --color-paper-2: oklch(16.5% 0.025 264);
    --color-paper-3: oklch(21% 0.034 265);
    --color-surface: oklch(16.5% 0.025 264);
    --color-ink: oklch(96.7% 0.003 265);
    --color-ink-2: oklch(87.2% 0.01 258);
    --color-ink-3: oklch(70.7% 0.022 261);
    --color-rule: oklch(23% 0.034 265);
    --color-rule-2: oklch(29.5% 0.033 258);
    --color-accent: oklch(70.2% 0.183 294);
    --color-accent-ink: oklch(74% 0.16 294);
    --color-accent-hover: oklch(81.1% 0.111 294);
    --color-accent-soft: oklch(24% 0.07 285);
    --color-accent-2: oklch(78.9% 0.154 212);
    --color-accent-2-ink: oklch(78.9% 0.154 212);
    --color-on-accent: oklch(13% 0.028 262);
    --color-focus: oklch(70.2% 0.183 294);
    --color-ok: oklch(76.5% 0.177 163);
    --color-warn: oklch(82.8% 0.189 84);
    --color-danger: oklch(71.2% 0.194 13);
    --color-shadow: oklch(0% 0 0);
    --color-graphite-rule: oklch(27.8% 0.033 257);
    --color-band: oklch(16.5% 0.025 264);
    --shadow: 0 20px 40px -12px color-mix(in oklch, var(--color-shadow) 55%, transparent);
    --shadow-lg: 0 40px 80px -24px color-mix(in oklch, var(--color-shadow) 75%, transparent);
    --glow: 0 0 130px -24px color-mix(in oklch, var(--color-accent) 50%, transparent);
    --atmo-veil-top: 42%;
    --atmo-veil-bottom: 84%;
    --atmo-glow: 20%;
  }

  /* Theme toggle (top-right): sun in light, moon in dark. */
  .theme-toggle {
    display: inline-grid; place-items: center; width: 36px; height: 36px; margin-left: 4px;
    border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--surface);
    color: var(--muted); cursor: pointer;
    flex: 0 0 auto;
    transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
  }
  .theme-toggle:hover { color: var(--fg); border-color: var(--color-ink-3); background: var(--panel); }
  .theme-toggle:active { background: var(--panel-2); }
  .theme-toggle svg { width: 18px; height: 18px; }
  .theme-toggle .moon { display: none; }
  :root[data-theme="dark"] .theme-toggle .sun { display: none; }
  :root[data-theme="dark"] .theme-toggle .moon { display: block; }

  * { box-sizing: border-box; }
  html { background: var(--bg); scroll-behavior: smooth; overflow-x: clip; }
  #app { position: relative; isolation: isolate; }
  /* One layer behind everything: an accent glow on every page, plus the mountain photo on Home. */
  .site-atmosphere {
    position: absolute; inset: 0 0 auto 0; z-index: -1; height: 420px; pointer-events: none;
    background: radial-gradient(ellipse 62% 70% at 50% -12%,
      color-mix(in oklch, var(--color-accent) var(--atmo-glow), transparent) 0%,
      color-mix(in oklch, var(--color-accent-2) 6%, transparent) 55%, transparent 100%);
  }
  #app:has(.home-hero) .site-atmosphere {
    height: min(86vh, 760px);
    background:
      radial-gradient(ellipse 62% 60% at 50% -12%,
        color-mix(in oklch, var(--color-accent) var(--atmo-glow), transparent) 0%,
        color-mix(in oklch, var(--color-accent-2) 6%, transparent) 55%, transparent 100%),
      linear-gradient(to bottom,
        color-mix(in oklch, var(--color-paper) var(--atmo-veil-top), transparent),
        color-mix(in oklch, var(--color-paper) var(--atmo-veil-bottom), transparent)),
      url(/assets/background.png) center top / cover no-repeat;
    -webkit-mask-image: linear-gradient(to bottom, black 0%, black 45%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 0%, black 45%, transparent 100%);
  }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--color-ink-2);
    font: 400 16px/1.6 var(--font-body);
    overflow-x: clip;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4, .logo {
    font-family: var(--font-display);
    font-style: normal;
    color: var(--color-ink);
  }
  code, pre, kbd, samp {
    font-family: var(--font-mono);
  }
  a { color: var(--link); text-decoration: none; }
  a:hover { color: var(--color-accent-hover); text-decoration: underline; }
  button, input, textarea, select { font: inherit; }
  a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible,
  textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px;
  }

  .wrap { width: min(calc(100% - 48px), 1140px); margin: 0 auto; }

  /* ---- header / footer ---- */
  header.site {
    position: sticky; top: 0; z-index: 30;
    border-bottom: 1px solid color-mix(in oklch, var(--line) 70%, transparent);
    background: color-mix(in oklch, var(--header-bg) 76%, transparent);
    -webkit-backdrop-filter: saturate(1.5) blur(14px);
    backdrop-filter: saturate(1.5) blur(14px);
  }
  header.site .wrap {
    display: flex; align-items: center; justify-content: space-between;
    height: 60px; gap: 24px;
  }
  .logo {
    display: inline-flex; align-items: center; gap: 12px; color: var(--fg);
    font-weight: 600; font-size: 18px; letter-spacing: -0.02em; white-space: nowrap;
  }
  .logo:hover { color: var(--fg); text-decoration: none; }
  .logo-mark {
    display: block; width: 28px; height: 28px; flex-shrink: 0;
    object-fit: contain; object-position: center; border-radius: var(--radius);
  }
  .logo-badge {
    font-family: var(--font-mono); font-size: 10px; font-weight: 500; color: var(--muted);
    border: 1px solid var(--line-2); padding: 2px 8px; border-radius: 4px;
    letter-spacing: 0.06em; text-transform: uppercase;
  }
  nav.top { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
  nav.top a {
    color: var(--soft); font-size: 14px; font-weight: 500; padding: 8px 12px;
    border-radius: var(--radius); white-space: nowrap;
    transition: color 0.15s ease, background-color 0.15s ease;
  }
  nav.top a:hover { color: var(--fg); background: var(--hover); text-decoration: none; }
  nav.top a:active { background: var(--panel-2); }
  nav.top a.icon-link { display: inline-flex; align-items: center; padding: 8px; color: var(--muted); }
  nav.top a.icon-link svg { width: 20px; height: 20px; display: block; }
  .nowrap { white-space: nowrap; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

  footer.site { border-top: 1px solid var(--line); color: var(--muted); font-size: 13.5px; }
  footer.site .wrap { padding: 24px 0; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px 24px; }
  footer.site a { color: var(--muted); font-weight: 500; white-space: nowrap; }
  footer.site a:hover { color: var(--fg); }
  .foot-links { display: inline-flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }

  /* ---- buttons / install ---- */
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-height: 44px; padding: 0 20px; border-radius: var(--radius);
    border: 1px solid transparent; font-family: var(--font-body); font-size: 15px; font-weight: 600;
    line-height: 1; white-space: nowrap; cursor: pointer;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease,
      transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
  }
  .button:hover { text-decoration: none; transform: translateY(-2px); }
  .button:active { transform: translateY(0); }
  .button:disabled, .button[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; transform: none; }
  .button.primary {
    color: var(--color-on-accent); background: var(--gradient-accent);
    border-color: color-mix(in oklch, var(--color-on-accent) 14%, transparent);
    box-shadow:
      0 8px 24px -6px color-mix(in oklch, var(--color-accent) 50%, transparent),
      inset 0 1px 0 color-mix(in oklch, var(--color-surface) 28%, transparent);
  }
  .button.primary:hover {
    color: var(--color-on-accent); filter: brightness(1.07);
    box-shadow:
      0 14px 32px -6px color-mix(in oklch, var(--color-accent) 62%, transparent),
      inset 0 1px 0 color-mix(in oklch, var(--color-surface) 28%, transparent);
  }
  .button.ghost {
    color: var(--fg); border-color: var(--line-2);
    background: color-mix(in oklch, var(--surface) 80%, transparent);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    box-shadow: var(--shadow);
  }
  .button.ghost:hover {
    color: var(--fg); background: var(--surface);
    border-color: color-mix(in oklch, var(--color-accent) 55%, var(--line-2));
  }

  .install-widget {
    display: inline-flex; align-items: center; justify-content: space-between;
    min-height: 44px; min-width: min(264px, 100%); padding: 0 16px;
    border: 1px solid var(--line-2); border-radius: var(--radius);
    background: var(--surface); color: var(--fg);
    font-family: var(--font-mono); font-size: 13.5px; cursor: pointer; text-align: left;
    white-space: nowrap; max-width: 100%; box-shadow: var(--shadow);
    transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.18s ease,
      transform 0.18s ease;
  }
  .install-widget:hover {
    border-color: color-mix(in oklch, var(--color-accent) 60%, var(--line-2));
    box-shadow: var(--shadow), 0 0 0 4px color-mix(in oklch, var(--color-accent) 14%, transparent);
    transform: translateY(-1px);
  }
  .install-widget:active { background: var(--panel); transform: translateY(0); }
  .install-widget .prompt { color: var(--color-accent-2-ink); font-weight: 600; margin-right: 8px; user-select: none; }
  .install-widget .command { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .install-widget .copy-btn { display: inline-flex; align-items: center; margin-left: 16px; color: var(--muted); transition: color 0.15s ease; }
  .install-widget:hover .copy-btn { color: var(--fg); }
  .install-widget .copy-icon { width: 15px; height: 15px; }
  .install-widget .copied-toast { display: none; color: var(--color-ok); font-size: 12px; font-weight: 500; }
  .install-widget[data-copied="true"] .copied-toast { display: inline; }
  .install-widget[data-copied="true"] .copy-icon { display: none; }

  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  code.inline, .bench-foot code {
    font-family: var(--font-mono); color: var(--green-2); background: var(--green-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 18%, transparent); border-radius: 5px; padding: 1px 8px; font-size: 0.85em;
  }

  /* ---- multiplier grid (frontend perf headline numbers) ---- */
  .mult-grid {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: color-mix(in oklch, var(--surface) 82%, transparent);
    box-shadow: var(--shadow), inset 0 1px 0 var(--edge);
  }
  .mult-item { padding: 24px; border-left: 1px solid var(--line); min-width: 0; }
  .mult-item:first-child { border-left: 0; }
  .mult-item strong { display: block; font-family: var(--font-display); font-size: clamp(30px, 3.6vw, 44px); line-height: 1; letter-spacing: -0.03em; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
  .mult-item span { display: block; margin-top: 12px; color: var(--muted); font-size: 13.5px; }

  /* ---- small shared labels ---- */
  .kicker {
    display: inline-block; margin: 0 0 12px; color: var(--color-accent-ink);
    font-family: var(--font-mono); font-size: 11.5px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .kicker:has(+ h1.page) { margin-top: 56px; }
  .kicker + h1.page { margin-top: 0; }
  .note { margin: 24px 0 0; color: var(--muted); font-size: 14px; }

  /* ---- code blocks ---- */
  pre.code {
    position: relative;
    background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--radius-lg);
    padding: 16px 20px; overflow-x: auto; font-size: 13px; line-height: 1.7; margin: 0;
    color: var(--code-fg); box-shadow: var(--shadow); max-width: 100%; min-width: 0;
  }
  pre.code code { display: block; min-width: 100%; width: max-content; font-family: var(--font-mono); }
  pre.code .k { color: var(--code-keyword); }
  pre.code .s { color: var(--code-string); }
  pre.code .c { color: var(--code-comment); font-style: italic; }
  pre.code .l { color: var(--code-literal); }

  /* ---- shared: /benchmarks tables + /docs prose (do not remove) ---- */
  main.wrap { padding-bottom: 48px; }
  h1.page { font-size: clamp(38px, 6vw, 60px); line-height: 1.02; letter-spacing: -0.02em; margin: 60px 0 16px; }
  p.lead { color: var(--muted); font-size: 18px; margin: 0 0 12px; max-width: 780px; }
  .bench h2 { font-size: 22px; margin: 44px 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; background: var(--panel); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bench-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; margin-top: 20px; }
  /* A three-number row is wider than a phone: the block scrolls, the page does not. */
  .bench-block { min-width: 0; overflow-x: auto; }
  .bench-block h2 { font-size: 18px; margin: 0 0 12px; }
  .bench-block table { font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr.hl td { background: var(--green-soft); color: var(--fg); font-weight: 700; }
  .caveat {
    background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--green);
    border-radius: var(--radius); padding: 16px 20px; margin: 24px 0; color: var(--muted); font-size: 14px;
  }
  .caveat b { color: var(--fg); }
  .prose { width: 100%; max-width: 760px; }
  .prose > h1:not(.page) {
    font-size: clamp(30px, 5vw, 44px); line-height: 1.1; letter-spacing: -0.02em;
    margin: 56px 0 16px; overflow-wrap: anywhere;
  }
  .prose h2 { font-size: 25px; margin: 48px 0 12px; letter-spacing: -0.01em; scroll-margin-top: 88px; }
  .prose h3 { scroll-margin-top: 88px; }
  .fix-prompts { margin: 12px 0 28px; }
  .fix-prompts > summary {
    display: inline-flex; align-items: center; min-height: 32px; cursor: pointer;
    font-size: 14px; font-weight: 600; color: var(--color-accent-ink);
  }
  .fix-prompts > summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
  .fix-prompts pre.code code { width: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .prose p, .prose ul { color: var(--soft); font-size: 15px; line-height: 1.72; }
  .prose ul { padding-left: 20px; }
  .prose li { margin: 8px 0; }
  .prose :not(pre) > code { background: var(--green-soft); border: 1px solid color-mix(in oklch, var(--color-accent) 18%, transparent); border-radius: 6px; padding: 1px 8px; font-size: 13px; color: var(--green-2); }
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
    gap: 8px;
  }
  .docs-side .nav-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 20px;
  }
  .docs-side .nav-group-title {
    padding: 0 12px 8px;
    font-family: var(--font-mono);
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
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
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
    border-color: color-mix(in oklch, var(--color-accent) 15%, transparent);
    font-weight: 700;
    box-shadow: inset 0 1px 0 color-mix(in oklch, var(--color-surface) 10%, transparent);
  }
  :root[data-theme="dark"] .docs-side a.active {
    background: color-mix(in oklch, var(--color-accent) 12%, transparent);
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
    padding-left: 20px;
  }
  .docs-toc .toc-title {
    font-family: var(--font-display);
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
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
    border-left: 2px solid transparent;
    padding-left: 8px;
    margin-left: -12px;
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
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
  }
  .docs-search-container input:focus {
    border-color: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
  }

  /* ---- code windows: a deep navy window with traffic-light controls and a filename tab ---- */
  .code-window {
    background: var(--code-bg); border: 1px solid var(--code-border); border-radius: var(--radius-lg);
    overflow: hidden; margin: 24px 0; min-width: 0; max-width: 100%;
    box-shadow: var(--shadow-lg), inset 0 1px 0 var(--edge);
  }
  .code-window-header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 16px; background: var(--color-graphite-2);
    border-bottom: 1px solid var(--code-border);
  }
  .code-window-dots { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; }
  .code-window-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--color-graphite-rule); }
  .code-window-dot.red { background: var(--color-dot-close); }
  .code-window-dot.yellow { background: var(--color-dot-min); }
  .code-window-dot.green { background: var(--color-dot-max); }
  .code-window-lang {
    font-family: var(--font-mono); font-size: 11px; font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--color-graphite-muted); text-transform: uppercase; letter-spacing: 0.06em;
  }
  .code-window pre.code {
    border: none; border-radius: 0; box-shadow: none; padding: 16px 20px; margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  }

  /* ---- responsive ---- */
  @media (max-width: 960px) {
    .mult-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .docs-shell { flex-direction: column; align-items: stretch; gap: 0; }
    .docs-side { position: static; flex-basis: auto; padding-top: 28px; width: 100%; }
    .docs-main { width: 100%; }
    .docs-side nav { flex-direction: row; flex-wrap: wrap; border-left: none; gap: 4px; }
    .docs-side .nav-group { width: 100%; flex-direction: row; flex-wrap: wrap; gap: 4px; }
    .docs-side .nav-group + .nav-group { margin-top: 8px; }
    .docs-side .nav-group-title { width: 100%; padding: 8px 0 2px; }
    .docs-side a { border: 1px solid var(--line); border-radius: var(--radius); margin-left: 0; }
  }
  @media (max-width: 900px) {
    /* The bar holds seven links plus three icons; below this it wraps onto a second row. */
    header.site { position: static; }
    header.site .wrap {
      position: relative; height: auto; padding: 12px 0;
      flex-direction: column; align-items: flex-start; gap: 8px;
    }
    nav.top { width: 100%; flex-wrap: wrap; gap: 0 4px; }
    nav.top a { padding-left: 0; padding-right: 12px; }
    nav.top a:hover { background: transparent; }
    nav.top a.icon-link { padding: 8px 12px 8px 0; }
    /* Lifted onto the logo row: left in the flow it lands alone on a row of its own once the links wrap. */
    .theme-toggle { position: absolute; top: 8px; right: 0; margin: 0; }
  }
  @media (max-width: 620px) {
    .wrap { width: min(calc(100% - 32px), 1140px); }
    table { font-size: 12px; }
    th, td { padding: 12px; }
    footer.site .wrap { flex-direction: column; }
    .mult-grid { grid-template-columns: minmax(0, 1fr); }
  }

  /* ---- /play playground - one editor, the responses beside it, the requests folded under it ---- */
  .play-head { max-width: 760px; margin-bottom: 24px; }

  /* Sticky controls bar (presets + Run) - never lost under an editor, always reachable. */
  .play-controls {
    position: sticky; top: 64px; z-index: 6;
    display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;
    margin-bottom: 16px; padding: 12px 16px;
    background: var(--header-bg);
    border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow);
  }
  .play-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .play-presets-label { font-size: 13px; color: var(--muted); }
  .play-preset {
    font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--soft);
    background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--radius);
    padding: 4px 12px; cursor: pointer; white-space: nowrap;
    transition: border-color .15s, color .15s, background .15s;
  }
  .play-preset:hover { color: var(--fg); border-color: var(--green); }
  .play-segment {
    display: inline-flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 4px; min-inline-size: 0;
    background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--radius);
  }
  .play-segment .play-preset { border: 1px solid transparent; background: transparent; }
  .play-segment .play-preset:hover { color: var(--fg); border-color: transparent; background: var(--hover); }
  .play-preset.active, .play-segment .play-preset.active:hover {
    color: var(--color-on-accent); border-color: transparent;
    background: var(--color-accent-ink);
  }
  .play-run-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .play-run { min-height: 40px; }
  .play-kbd-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
  .play-share { min-height: 40px; margin-left: auto; }
  .play-share-msg { font-size: 12px; color: var(--muted); min-height: 1em; }
  /* Embed mode (/play?embed=1): strip site chrome so /play drops cleanly into an <iframe>.
     No viewport units in here: the host sizes the frame from this page's own height. */
  .play-embed header.site, .play-embed footer.site, .play-embed .site-atmosphere,
  .play-embed .nifra-bot-container, .play-embed .play-head,
  .play-embed .play-share, .play-embed .play-share-msg { display: none; }
  .play-embed main.wrap { width: 100%; padding: 16px; }
  .play-embed .play-controls { position: static; box-shadow: none; }
  .play-embed .play-grid { margin-bottom: 0; }
  .play-embed .play-pane, .play-embed .play-requests { box-shadow: none; }
  .play-embed .play-editor-code { min-height: 300px; }
  .play-kbd {
    font-family: var(--font-mono); font-size: 11px; color: var(--soft);
    background: var(--surface); border: 1px solid var(--line-2); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 8px; min-width: 18px; text-align: center; line-height: 1.5;
  }

  .play-grid {
    display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 16px; align-items: stretch; margin-bottom: 32px;
  }
  .play-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .play-pane--code { flex: 1 1 auto; }
  .play-pane {
    display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
  }
  /* The response pane takes its height from the editor column and scrolls inside it, so a long
     response never pushes the editor around. */
  .play-pane--results { contain: size; min-height: 320px; border-color: var(--line-2); }
  /* The requests a run sends. Folded: the examples fill it in, so most visitors never open it. */
  .play-requests {
    flex: 0 0 auto; min-width: 0; overflow: hidden;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-lg);
    box-shadow: var(--shadow);
  }
  .play-requests > summary {
    display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px;
    background: var(--panel-2); cursor: pointer; user-select: none; list-style: none;
    transition: background 0.15s ease;
  }
  .play-requests > summary::-webkit-details-marker { display: none; }
  .play-requests > summary:hover { background: var(--hover); }
  .play-requests > summary:active { background: var(--panel); }
  .play-requests > summary:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
  .play-requests[open] > summary { border-bottom: 1px solid var(--line); }
  .play-requests-toggle { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--color-accent-ink); white-space: nowrap; }
  .play-requests-toggle::after { content: "Edit"; }
  .play-requests[open] .play-requests-toggle::after { content: "Hide"; }
  .play-pane-head {
    display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
    padding: 8px 16px; background: var(--panel-2); border-bottom: 1px solid var(--line);
  }
  .play-window-title { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: 0.02em; }
  .play-pane-hint { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); opacity: 0.75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .play-lang-badge {
    margin-left: auto; font-family: var(--font-mono); font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em;
    color: var(--green-2); background: var(--green-soft); border: 1px solid color-mix(in oklch, var(--color-accent) 18%, transparent);
    border-radius: 5px; padding: 1px 8px;
  }
  .play-live-dot { width: 7px; height: 7px; border-radius: 99px; background: var(--green); box-shadow: 0 0 0 3px var(--green-soft); margin-left: auto; }
  .play-editor {
    flex: 1 1 auto; width: 100%; box-sizing: border-box; resize: none; tab-size: 2;
    font-family: var(--font-mono); font-size: 13.5px; line-height: 1.6; color: var(--code-fg);
    background: var(--code-bg); border: 0; border-radius: 0; padding: 16px; outline: none;
  }
  .play-editor:focus { box-shadow: inset 0 0 0 2px var(--green); }
  .play-editor::selection { background: var(--green-soft); }
  .play-editor-code { min-height: clamp(260px, 50vh, 540px); }
  .play-editor-requests { display: block; min-height: 150px; }
  .play-results {
    flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 12px;
    padding: 16px; overflow: auto;
  }
  .play-running { color: var(--muted); font-family: var(--font-mono); font-size: 13px; padding: 8px 2px; }
  .play-card { border: 1px solid var(--line-2); border-radius: var(--radius); overflow: hidden; }
  .play-card-head {
    display: flex; align-items: center; gap: 12px; padding: 8px 12px;
    background: var(--panel-2); border-bottom: 1px solid var(--line);
  }
  .play-method { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--green-2); }
  .play-path { font-family: var(--font-mono); font-size: 12px; color: var(--soft); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .play-badge { font-family: var(--font-mono); font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: var(--radius); }
  .play-badge-ok { color: var(--color-ok); background: var(--green-soft); }
  .play-badge-warn { color: var(--color-warn); background: color-mix(in oklch, var(--color-warn) 12%, transparent); }
  .play-badge-err { color: var(--color-danger); background: color-mix(in oklch, var(--color-danger) 12%, transparent); }
  .play-body { margin: 0; padding: 12px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5; color: var(--fg); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  .play-body-err { color: var(--color-danger); }
  .play-noscript { color: var(--muted); margin-top: 16px; }

  @media (max-width: 900px) {
    .play-grid { grid-template-columns: minmax(0, 1fr); }
    .play-pane--results { contain: none; min-height: 0; }
    .play-results { min-height: 200px; }
    .play-embed .play-results { max-height: 260px; }
  }
  @media (max-width: 640px) {
    .play-controls { position: static; }
    .play-presets-label, .play-kbd-hint { display: none; }
    .play-editor-code, .play-embed .play-editor-code { min-height: 220px; }
    .play-results { min-height: 160px; }
  }

  /* ---- /frameworks live demo - one app, five renderers, real measured bundle sizes ---- */
  .fw-head { display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
  /* A <fieldset> for grouping semantics - reset its default chrome; it lays out as a pill row. */
  .fw-toggle { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 24px; padding: 0; border: 0; min-inline-size: 0; }
  .fw-toggle-btn {
    display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--panel); color: var(--muted);
    font-family: var(--font-mono); font-size: 13px; font-weight: 700; cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .fw-toggle-btn:hover { color: var(--fg); border-color: var(--line-2); }
  .fw-toggle-btn.active { color: var(--fg); border-color: var(--green); background: var(--green-soft); }
  .fw-toggle-size { font-weight: 600; color: var(--soft); font-size: 12px; }
  .fw-toggle-btn.active .fw-toggle-size { color: var(--green-2); }

  .fw-panels { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 0.78fr); gap: 24px; align-items: start; }
  .fw-stage-wrap {
    border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--panel);
    overflow: hidden; min-height: 280px;
  }
  .fw-stage-head {
    display: flex; align-items: center; gap: 12px; padding: 12px 16px;
    border-bottom: 1px solid var(--line); background: var(--panel-2);
  }
  .fw-stage-title { font-family: var(--font-mono); font-size: 12.5px; font-weight: 700; color: var(--fg); }
  .fw-stage-live {
    display: inline-flex; align-items: center; gap: 8px; margin-left: auto;
    font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--green-2);
  }
  .fw-stage-live::before {
    content: ""; width: 7px; height: 7px; border-radius: 99px; background: var(--green);
  }
  .fw-stage-body { padding: 16px 20px; max-height: 360px; overflow: auto; }
  /* The shared catalog markup - same DOM whichever framework rendered it. */
  .fw-stage-body main h1 { font-size: 16px; margin: 0 0 12px; color: var(--fg); }
  .fw-stage-body main ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
  .fw-stage-body main li {
    font-family: var(--font-mono); font-size: 12px; color: var(--soft); padding: 4px 8px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2);
  }

  .fw-sizes { border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--panel); padding: 20px 20px 20px; }
  .fw-sizes h3 { margin: 0 0 4px; font-size: 14px; color: var(--fg); }
  .fw-sizes-sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; line-height: 1.45; }
  .fw-bar-row { display: grid; grid-template-columns: 96px 1fr 70px; align-items: center; gap: 12px; padding: 8px 8px; border-radius: 8px; transition: background 0.15s ease; }
  .fw-bar-row.active { background: var(--green-soft); }
  .fw-bar-name { display: flex; flex-direction: column; gap: 1px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
  .fw-bar-row.active .fw-bar-name { color: var(--fg); font-weight: 700; }
  .fw-bar-idiom { font-size: 10.5px; font-weight: 500; color: var(--soft); }
  .fw-bar-track { height: 18px; border-radius: 5px; background: var(--panel-2); overflow: hidden; }
  .fw-bar-fill { display: block; height: 100%; border-radius: 5px; background: var(--bar-fill); transform-origin: left; animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  .fw-bar-row.active .fw-bar-fill { background: var(--color-accent-ink); }
  .fw-bar-value { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--soft); text-align: right; }
  .fw-bar-row.active .fw-bar-value { color: var(--green-2); font-weight: 700; }
  .fw-foot { margin: 28px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
  .fw-noscript { color: var(--muted); margin-top: 16px; }

  @media (max-width: 880px) {
    .fw-panels { grid-template-columns: 1fr; }
  }

  /* ---- Nifra bot island ---- */
  .nifra-bot-container {
    position: fixed;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 16px;
    pointer-events: none;
    user-select: none;
    touch-action: none;
    max-width: min(360px, calc(100vw - 28px));
  }
  .nifra-bot-container:not(.dragging) {
    transition: opacity 0.25s ease, visibility 0.25s ease, transform 0.25s ease;
  }
  .nifra-bot-container.nifra-bot-home-deferred {
    opacity: 0;
    visibility: hidden;
    transform: translateY(12px);
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
    background: color-mix(in oklch, var(--surface) 94%, var(--panel) 6%);
    color: var(--fg);
    box-shadow: 0 18px 46px color-mix(in oklch, var(--color-shadow) 18%, transparent), var(--shadow);


  }
  :root[data-theme="dark"] .nifra-bot-panel {
    background: color-mix(in oklch, var(--surface) 88%, var(--ink) 12%);
    box-shadow: 0 24px 58px color-mix(in oklch, var(--color-shadow) 46%, transparent);
  }
  .nifra-bot-container[data-open="false"] .nifra-bot-panel {
    display: none;
  }
  .nifra-bot-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 12px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .nifra-bot-panel-head strong {
    display: block;
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    line-height: 1.15;
  }
  .nifra-bot-panel-head span {
    display: block;
    margin-top: 4px;
    color: var(--green-2);
    font-family: var(--font-mono);
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
    padding: 8px 12px;
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
    color: var(--color-on-accent);
    background: var(--color-accent-ink);
  }
  .nifra-bot-message.bot.thinking {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--green);
    background: color-mix(in oklch, var(--color-accent) 5%, transparent);
    border-color: color-mix(in oklch, var(--color-accent) 30%, transparent);
    white-space: pre-wrap;
  }
  :root[data-theme="light"] .nifra-bot-message.bot.thinking {
    color: var(--green-2);
    background: color-mix(in oklch, var(--color-accent) 4%, transparent);
    border-color: color-mix(in oklch, var(--color-accent) 25%, transparent);
    text-shadow: none;
    box-shadow: none;
  }
  .nifra-bot-message pre.code {
    background: var(--code-bg);
    border: 1px solid var(--code-border);
    border-left: 3px solid var(--green-2);
    border-radius: 6px;
    padding: 8px 12px;
    overflow-x: auto;
    font-size: 11.5px;
    line-height: 1.45;
    margin: 8px 0 0;
    color: var(--code-fg);
  }
  .nifra-bot-message code.inline {
    font-family: var(--font-mono);
    color: var(--green-2);
    background: var(--green-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 15%, transparent);
    border-radius: 4px;
    padding: 1px 4px;
    font-size: 0.9em;
  }
  .nifra-bot-quick {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    padding: 0 8px;
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
    padding: 0 12px;
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
    color: var(--color-on-accent);
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
  }
  .nifra-bubble-container.visible {
    display: block;
  }
  .nifra-bubble {
    pointer-events: auto;
    /* Opaque on purpose: a live blur re-samples the scrolling backdrop every frame. */
    background: var(--surface);
    color: var(--fg);
    border: 1px solid var(--line-2);
    padding: 12px 16px;
    border-radius: var(--radius-lg);
    font-size: 13.5px;
    line-height: 1.45;
    max-width: 250px;
    text-align: left;
    overflow-wrap: anywhere;
    cursor: pointer;
    box-shadow: 0 8px 24px color-mix(in oklch, var(--color-shadow) 14%, transparent);
  }

  .nifra-bot {
    position: relative;
    display: block;
    pointer-events: auto;
    width: 52px;
    height: 52px;
    flex: 0 0 auto;
    border: 0;
    border-radius: var(--radius-lg);
    cursor: grab;
    background: transparent;
    box-shadow: none;
    transition: opacity 0.15s ease;
    opacity: 0.92;
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
  }
  .nifra-bot-container.dragging .nifra-bot { cursor: grabbing; }
  .nifra-bot:hover { opacity: 1; }
  .nifra-bot:active { opacity: 0.8; }
  .nifra-bot:focus-visible { opacity: 1; outline: 2px solid var(--color-focus); outline-offset: 2px; }

  /* "Dependencies Nifra replaces": ruled lists, old stack on the left, the package on the right. */
  .replace-groups { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
  .replace-cat {
    min-width: 0; padding: 20px 20px 8px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow);
  }
  .replace-cat-head {
    margin: 0; padding: 0 0 12px; border-bottom: 1px solid var(--line);
    font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--color-accent-ink);
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .replace-row:last-child { border-bottom: 0; }
  .replace-row {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    padding: 12px 0; border-bottom: 1px solid var(--line); min-width: 0;
  }
  .replace-old { color: var(--muted); font-size: 13.5px; min-width: 0; }
  .replace-arrow { color: var(--color-accent-2-ink); flex: 0 0 auto; margin-left: auto; }
  .replace-pkg {
    font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; color: var(--fg);
    white-space: nowrap; flex: 0 0 auto;
  }
  @media (max-width: 1020px) { .replace-groups { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 680px) { .replace-groups { grid-template-columns: minmax(0, 1fr); } }

  @media (max-width: 620px) {
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
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--muted);
  }
  .docs-breadcrumbs .crumb-sec {
    color: var(--muted);
  }
  .docs-breadcrumbs .crumb-sep {
    color: var(--line-2);
    margin: 0 8px;
  }
  .docs-breadcrumbs .crumb-active {
    color: var(--fg);
    font-weight: 700;
  }
  .feed-agent-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--green-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 22%, transparent);
    color: var(--green-2);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 700;
    cursor: pointer;
    transition: color 0.15s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.15s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .feed-agent-btn:hover {
    background: var(--green-2);
    color: var(--color-on-accent);
    border-color: var(--green-2);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px color-mix(in oklch, var(--color-accent) 15%, transparent);
  }
  .feed-agent-btn.copied {
    background: var(--green);
    color: var(--color-on-accent);
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
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    padding: 4px 8px;
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
    background: color-mix(in oklch, var(--color-accent) 5%, transparent);
    border-left-color: var(--green-2);
  }
  .alert-callout.tip {
    background: color-mix(in oklch, var(--color-accent) 5%, transparent);
    border-left-color: var(--green);
  }
  .alert-callout.warning {
    background: color-mix(in oklch, var(--color-warn) 5%, transparent);
    border-left-color: var(--amber);
  }
  .alert-callout.caution {
    background: color-mix(in oklch, var(--color-danger) 5%, transparent);
    border-left-color: var(--color-danger);
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
  .alert-callout.caution .alert-head { color: var(--color-danger); }
  .alert-body p:last-child {
    margin-bottom: 0;
  }

  /* Responsive styles for docs layout */
  @media (max-width: 1200px) {
    .docs-shell {
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 32px;
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
      gap: 8px;
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

  /* A changed tip fades in, so it is noticeable without moving. */
  .nifra-bubble.pulse { animation: tip-fade 0.25s ease-out; }
  @keyframes tip-fade { from { opacity: 0; } to { opacity: 1; } }

  /* Docs: collapse the right "On this page" column when a page has no headings */
  .docs-shell.no-toc { grid-template-columns: 240px minmax(0, 1fr); }
  .docs-shell.no-toc .docs-toc { display: none; }

  /* ===================== Home ===================== */
  .home-hero {
    display: grid; grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
    gap: 56px; align-items: center; padding: 80px 0 72px;
  }
  .home-hero-copy { min-width: 0; }
  .hero-badge {
    display: inline-flex; align-items: center; gap: 10px; margin: 0 0 24px; padding: 6px 14px 6px 12px;
    border: 1px solid color-mix(in oklch, var(--color-accent) 30%, transparent); border-radius: 999px;
    background: color-mix(in oklch, var(--color-accent-soft) 78%, transparent);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: var(--color-accent-ink); font-size: 13px; font-weight: 600; line-height: 1.4; white-space: nowrap;
  }
  .badge-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent-2); flex: 0 0 auto; }
  .badge-dot::after {
    content: ""; position: absolute; inset: -4px; border-radius: 50%; background: var(--color-accent-2);
    opacity: 0.35; animation: badge-pulse 2s cubic-bezier(0.24, 0, 0.38, 1) infinite;
  }
  @keyframes badge-pulse { 0% { transform: scale(1); opacity: 0.5; } 100% { transform: scale(2.4); opacity: 0; } }
  .home-hero h1 {
    margin: 0; font-size: clamp(34px, 4.6vw, 58px); font-weight: 700; line-height: 1.05;
    letter-spacing: -0.035em; text-wrap: balance; overflow-wrap: anywhere; min-width: 0;
  }
  .home-hero h1 b {
    font-weight: inherit; color: transparent;
    background: var(--gradient-text); -webkit-background-clip: text; background-clip: text;
    -webkit-box-decoration-break: clone; box-decoration-break: clone;
  }
  .home-lede { margin: 24px 0 0; max-width: 52ch; font-size: 17px; line-height: 1.6; }
  .home-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 32px 0 0; }
  .home-install { margin: 32px 0 0; }
  .home-install + .home-actions { margin-top: 12px; }
  .home-fine { margin: 16px 0 0; color: var(--muted); font-size: 13.5px; }

  /* ---- hero demo: four frames of one change, played once, then stepped by hand ---- */
  .demo {
    --demo-step: 5s;
    position: relative; margin: 0; min-width: 0; overflow: hidden;
    color: var(--color-graphite-ink);
    /* A hairline that runs accent to accent: the fill sits on the padding box, the gradient on the border. */
    background:
      linear-gradient(var(--color-graphite), var(--color-graphite)) padding-box,
      linear-gradient(140deg,
        color-mix(in oklch, var(--color-graphite-accent) 75%, var(--color-graphite-rule)),
        var(--color-graphite-rule) 32%, var(--color-graphite-rule) 68%,
        color-mix(in oklch, var(--color-graphite-accent-2) 65%, var(--color-graphite-rule))) border-box;
    border: 1px solid transparent; border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg), var(--glow), inset 0 1px 0 var(--edge);
  }
  .demo-bar {
    display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px;
    padding: 12px 16px; background: var(--color-graphite-2);
    border-bottom: 1px solid var(--color-graphite-rule);
  }
  .demo-title {
    font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; white-space: nowrap;
    color: var(--color-graphite-muted);
  }
  /* Kept in the figure's own box (not display:none) so the group stays keyboard-operable, and
     pinned to its top-left so choosing a step never scrolls the page. */
  .demo-radio {
    position: absolute; top: 0; left: 0; width: 1px; height: 1px; margin: 0;
    opacity: 0; pointer-events: none;
  }
  .demo-steps { display: flex; align-items: stretch; border-bottom: 1px solid var(--color-graphite-rule); }
  .demo-step, .demo-replay {
    position: relative; display: inline-flex; align-items: center; gap: 8px;
    min-height: 44px; padding: 0 16px; cursor: pointer; white-space: nowrap; user-select: none;
    font-family: var(--font-mono); font-size: 11px; font-weight: 500;
    letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--color-graphite-muted);
    transition: color 0.15s ease;
  }
  .demo-step b { font-weight: 500; opacity: 0.6; }
  .demo-step:hover, .demo-replay:hover { color: var(--color-graphite-ink); }
  .demo-step:active, .demo-replay:active { color: var(--color-graphite-accent); }
  .demo-step::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
    background: linear-gradient(90deg, var(--color-graphite-accent), var(--color-graphite-accent-2));
    opacity: 0; transform-origin: left center;
  }
  .demo-replay { margin-left: auto; }
  /* Replay always points at the autoplay radio that is NOT checked, so it restarts from any state. */
  .demo-replay-b { display: none; }
  #demo-auto:checked ~ .demo-steps .demo-replay-a { display: none; }
  #demo-auto:checked ~ .demo-steps .demo-replay-b { display: inline-flex; }
  #demo-auto:focus-visible ~ .demo-steps .demo-replay,
  #demo-auto-b:focus-visible ~ .demo-steps .demo-replay {
    outline: 2px solid var(--color-graphite-accent); outline-offset: -2px;
  }

  .demo-screen { position: relative; display: grid; padding: 20px; }
  .demo-frame {
    grid-area: 1 / 1; min-width: 0; display: flex; flex-direction: column;
    opacity: 0; visibility: hidden;
  }
  .demo-body { min-width: 0; padding-bottom: 20px; }
  .demo-file {
    margin: 0 0 8px; font-family: var(--font-mono); font-size: 11px; font-weight: 500;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-graphite-muted);
  }
  .demo-line {
    display: grid; grid-template-columns: 2ch minmax(0, 1fr);
    margin: 0 -20px; padding: 0 20px;
    font-family: var(--font-mono); font-size: 12.5px; line-height: 1.75;
    color: var(--color-graphite-ink);
  }
  .demo-line > i { font-style: normal; color: var(--color-graphite-muted); user-select: none; }
  .demo-line > span { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .demo-gap { margin-top: 16px; }
  .demo-line[data-k="add"] {
    color: var(--color-graphite-ok);
    background: color-mix(in oklch, var(--color-graphite-ok) 10%, transparent);
  }
  .demo-line[data-k="del"] {
    color: var(--color-graphite-danger);
    background: color-mix(in oklch, var(--color-graphite-danger) 10%, transparent);
  }
  .demo-line[data-k="add"] > i, .demo-line[data-k="del"] > i { color: inherit; }
  .demo-line[data-k="cmd"] > i { color: var(--color-graphite-accent-2); }
  .demo-line[data-k="err"] { color: var(--color-graphite-danger); }
  .demo-line[data-k="ok"] { color: var(--color-graphite-ok); }
  .demo-line[data-k="dim"] { color: var(--color-graphite-muted); }
  /* What the agent was asked, in prose: the one line that is not code or CLI output. */
  .demo-line[data-k="ask"] {
    margin-bottom: 14px; padding-top: 8px; padding-bottom: 8px;
    font-family: var(--font-body); font-size: 13.5px; line-height: 1.5;
    background: color-mix(in oklch, var(--color-graphite-accent) 14%, transparent);
  }
  .demo-line[data-k="ask"] > i { font-family: var(--font-mono); color: var(--color-graphite-accent); }
  .demo-cap {
    margin: auto 0 0; padding-top: 16px; border-top: 1px solid var(--color-graphite-rule);
    font-family: var(--font-body); font-size: 13.5px; line-height: 1.5;
    color: var(--color-graphite-muted);
  }
  .demo-cap code { font-size: 0.92em; color: var(--color-graphite-ink); }
${demoAutoplay("demo-auto", "a")}${demoAutoplay("demo-auto-b", "b")}${demoManual}
  @keyframes demo-line-m { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  /* Reading a frame holds it. The autoplay rules carry an id, so this needs the flag to win. */
  .demo:has(.demo-screen:hover) .demo-frame,
  .demo:has(.demo-screen:hover) .demo-line,
  .demo:has(.demo-screen:hover) .demo-step::after { animation-play-state: paused !important; }
  @media (prefers-reduced-motion: reduce) {
    /* No timed playback: open on the failing check and leave the steps to be chosen by hand. */
    .demo .demo-frame, .demo .demo-line, .demo .demo-step::after { animation: none !important; }
    .demo .demo-replay { display: none !important; }
    #demo-auto:checked ~ .demo-screen .demo-frame[data-step="2"],
    #demo-auto-b:checked ~ .demo-screen .demo-frame[data-step="2"] { opacity: 1; visibility: visible; }
    #demo-auto:checked ~ .demo-steps .demo-step[data-step="2"]::after,
    #demo-auto-b:checked ~ .demo-steps .demo-step[data-step="2"]::after { opacity: 1; }
  }

  /* ---- proof numbers ---- */
  .home-proof {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 0; padding: 0; list-style: none; overflow: hidden;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: color-mix(in oklch, var(--surface) 84%, transparent);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    box-shadow: var(--shadow);
  }
  .home-proof li { padding: 28px 24px; border-left: 1px solid var(--line); min-width: 0; }
  .home-proof li:first-child { border-left: 0; }
  .home-proof strong {
    display: block; font-family: var(--font-display); font-size: clamp(28px, 3.2vw, 40px);
    font-weight: 600; line-height: 1; letter-spacing: -0.03em; color: var(--fg);
    font-variant-numeric: tabular-nums;
  }
  .home-proof span { display: block; margin-top: 12px; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
  .home-proof-note { margin: 16px 0 40px; font-size: 13.5px; }

  /* ---- what it replaces: one row per category, the full table is further down ---- */
  .home-swap { margin: 0 0 96px; }
  .home-swap-title { margin: 0 0 16px; font-size: 15px; font-weight: 600; color: var(--fg); }
  .home-swap-list {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;
  }
  .home-swap-list li {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0;
    padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius);
    background: color-mix(in oklch, var(--surface) 84%, transparent);
  }
  .home-swap-list .replace-arrow { margin-left: 0; }

  /* ---- sections ---- */
  .home-section { margin: 0 0 96px; }
  .home-head { max-width: 62ch; margin: 0 0 32px; }
  .home-section h2, .home-band h2, .home-end h2 {
    margin: 0; font-size: clamp(26px, 3vw, 36px); font-weight: 600; line-height: 1.12;
    letter-spacing: -0.025em; text-wrap: balance; overflow-wrap: anywhere; min-width: 0;
  }
  .home-copy { min-width: 0; }
  .home-head p, .home-copy > p { margin: 16px 0 0; max-width: 60ch; }
  .home-link { display: inline-block; margin-top: 24px; font-weight: 500; white-space: nowrap; }
  .home-section .code-window, .home-band .code-window { margin: 0; }
  .home-duo { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; align-items: start; }
  .home-split {
    display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
    gap: 56px; align-items: start;
  }
  .home-list, .home-runtimes {
    list-style: none; margin: 32px 0 0; padding: 4px 20px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow);
  }
  .home-list li { padding: 16px 0; border-bottom: 1px solid var(--line); }
  .home-list li:last-child, .home-runtimes li:last-child { border-bottom: 0; }
  .home-list code { display: block; font-size: 13px; font-weight: 600; color: var(--color-accent-ink); }
  .home-list span { display: block; margin-top: 4px; color: var(--muted); font-size: 14px; line-height: 1.55; }

  /* ---- the one dark band. It sits inside .wrap, so one viewport-wide layer behind it paints it
     edge to edge (a single layer: a shadow beside the box leaves a seam on a fractional pixel). ---- */
  .home-band {
    position: relative; isolation: isolate;
    display: grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
    gap: 56px; align-items: start;
    margin: 0 0 96px; padding: 72px 0;
    color: var(--color-graphite-ink);
  }
  .home-band::before {
    content: ""; position: absolute; z-index: -1;
    top: 0; bottom: 0; left: calc(50% - 50vw); right: calc(50% - 50vw);
    background:
      radial-gradient(ellipse 50% 90% at 14% 0%, color-mix(in oklch, var(--color-graphite-accent) 20%, transparent), transparent 70%),
      radial-gradient(ellipse 45% 80% at 90% 100%, color-mix(in oklch, var(--color-graphite-accent-2) 13%, transparent), transparent 70%),
      var(--color-band);
    border-top: 1px solid var(--color-graphite-rule); border-bottom: 1px solid var(--color-graphite-rule);
  }
  .home-band .kicker { color: var(--color-graphite-accent); }
  .home-band h2 { color: var(--color-graphite-ink); }
  .home-band .home-copy > p { color: var(--color-graphite-muted); }
  .home-band .home-copy > p code { color: var(--color-graphite-ink); }
  .home-band a { color: var(--color-graphite-accent); }
  .home-band a:hover { color: var(--color-graphite-ink); }
  .home-band a:focus-visible, .home-band button:focus-visible { outline-color: var(--color-graphite-accent); }
  .home-band .install-widget {
    margin-top: 32px; background: var(--color-graphite-2); color: var(--color-graphite-ink);
    border-color: var(--color-graphite-rule);
  }
  .home-band .install-widget:hover { border-color: var(--color-graphite-muted); }
  .home-band .install-widget:active { background: var(--color-graphite); }
  .home-band .install-widget .prompt { color: var(--color-graphite-accent-2); }
  .home-band .install-widget .copy-btn { color: var(--color-graphite-muted); }
  .home-band .install-widget:hover .copy-btn { color: var(--color-graphite-ink); }
  .home-band .install-widget .copied-toast { color: var(--color-graphite-ok); }
  .home-band-links { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 24px; }
  .home-band-links a { font-weight: 500; white-space: nowrap; }
  /* A timeline: numbered circles joined by a hairline. */
  .home-tools { list-style: none; margin: 0; padding: 0; }
  .home-tools li {
    position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); column-gap: 16px;
    padding: 0 0 24px;
  }
  .home-tools li:last-child { padding-bottom: 0; }
  .home-tools li::before {
    content: ""; position: absolute; left: 17.5px; top: 40px; bottom: 4px; width: 1px;
    background: var(--color-graphite-rule);
  }
  .home-tools li:last-child::before { display: none; }
  .home-tools .n {
    display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%;
    border: 1px solid color-mix(in oklch, var(--color-graphite-accent) 55%, var(--color-graphite-rule));
    background: var(--color-graphite-2); box-shadow: inset 0 1px 0 var(--edge);
    font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--color-graphite-accent);
  }
  .home-tools li > div { padding-top: 6px; min-width: 0; }
  .home-tools code { display: block; font-size: 12.5px; color: var(--color-graphite-accent); }
  .home-tools strong { display: block; margin-top: 4px; font-size: 15px; font-weight: 600; color: var(--color-graphite-ink); }
  .home-tools p { margin: 4px 0 0; font-size: 14px; line-height: 1.55; color: var(--color-graphite-muted); }

  /* The recording spans the band under the copy and the loop. No drawn window around it: the
     player is the chrome. */
  .home-film { grid-column: 1 / -1; margin: 0; min-width: 0; }
  .home-film video {
    display: block; width: 100%; height: auto; aspect-ratio: 32 / 21;
    border: 1px solid var(--color-graphite-rule); border-radius: var(--radius-lg);
    background: var(--color-graphite); box-shadow: var(--shadow-lg);
  }
  .home-film video:focus-visible { outline: 2px solid var(--color-graphite-accent); outline-offset: 3px; }
  .home-film figcaption {
    margin-top: 12px; max-width: 76ch; font-size: 13.5px; line-height: 1.55;
    color: var(--color-graphite-muted);
  }

  /* ---- the embedded playground ---- */
  .home-play {
    overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--bg); box-shadow: var(--shadow-lg);
  }
  /* The height is a first guess; the frame reports its real height once it has loaded. */
  .home-play iframe { display: block; width: 100%; height: 520px; border: 0; }

  /* ---- measured bars + the compare row ---- */
  .home-bars-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
  .home-bars {
    min-width: 0; margin: 0; padding: 24px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow);
  }
  .home-bars h3 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--fg); }
  .home-bars-unit { margin: 4px 0 20px; font-size: 13px; color: var(--muted); }
  .home-bars ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
  .home-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: baseline; }
  .home-bar-name { min-width: 0; font-size: 13.5px; font-weight: 500; color: var(--muted); overflow-wrap: anywhere; }
  .home-bar-value {
    font-family: var(--font-mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--soft);
  }
  .home-bar-track {
    grid-column: 1 / -1; height: 10px; border-radius: 99px; background: var(--panel-2); overflow: hidden;
  }
  .home-bar-fill {
    display: block; height: 100%; width: calc(var(--w) * 1%); min-width: 4px;
    border-radius: inherit; background: var(--bar-fill);
  }
  .home-bar[data-you] .home-bar-name { color: var(--fg); font-weight: 600; }
  .home-bar[data-you] .home-bar-value { color: var(--color-accent-ink); font-weight: 600; }
  .home-bar[data-you] .home-bar-fill { background: var(--gradient-accent); }
  .home-bars-note { margin: 16px 0 0; max-width: 76ch; font-size: 13.5px; color: var(--muted); }
  .home-vs {
    list-style: none; margin: 40px 0 0; padding: 0;
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px;
  }
  .home-vs li { min-width: 0; }
  .home-vs a {
    display: flex; flex-direction: column; height: 100%; padding: 20px;
    border: 1px solid var(--line); border-radius: var(--radius-lg);
    background: var(--surface); box-shadow: var(--shadow); color: inherit;
    transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
  }
  .home-vs a:hover { text-decoration: none; border-color: var(--line-2); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
  .home-vs a:active { transform: none; box-shadow: var(--shadow); }
  .home-vs strong { font-size: 15px; font-weight: 600; color: var(--fg); }
  .home-vs p { margin: 8px 0 16px; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
  .home-vs-go { margin-top: auto; font-size: 13.5px; font-weight: 500; color: var(--color-accent-ink); white-space: nowrap; }

  /* ---- runtimes + framework switcher ---- */
  .home-runtimes li {
    display: grid; grid-template-columns: 104px minmax(0, 1fr); column-gap: 16px;
    padding: 14px 0; border-bottom: 1px solid var(--line);
  }
  .home-runtimes strong { font-weight: 600; color: var(--fg); font-size: 15px; }
  .home-runtimes span { color: var(--muted); font-size: 13.5px; }
  .home-runtimes code { display: block; margin-top: 4px; font-size: 12px; color: var(--soft); overflow-wrap: anywhere; }
  .home-fw { position: relative; min-width: 0; }
  .home-fw-radio {
    position: absolute; top: 0; left: 0; width: 1px; height: 1px; margin: 0;
    opacity: 0; pointer-events: none;
  }
  .home-fw-tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
  .home-fw-tabs label {
    display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; margin-bottom: -1px;
    border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; user-select: none;
    font-size: 14px; font-weight: 500; color: var(--muted);
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .home-fw-tabs label:hover { color: var(--fg); }
  .home-fw-tabs label:active { color: var(--color-accent-ink); }
  .home-fw-panel { display: none; }
${homeFwRules}
  /* ---- closing ---- */
  .home-end {
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 56px; align-items: center;
    margin: 0 0 48px; padding: 56px;
    border: 1px solid var(--line); border-radius: calc(var(--radius-lg) + 6px);
    background:
      radial-gradient(ellipse 60% 120% at 0% 0%, color-mix(in oklch, var(--color-accent) 13%, transparent), transparent 62%),
      radial-gradient(ellipse 50% 110% at 100% 100%, color-mix(in oklch, var(--color-accent-2) 10%, transparent), transparent 62%),
      var(--surface);
    box-shadow: var(--shadow);
  }
  .home-more { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .home-more a {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    min-height: 52px; border-bottom: 1px solid var(--line);
    color: var(--fg); font-weight: 500; white-space: nowrap;
    transition: color 0.15s ease;
  }
  .home-more a:hover { color: var(--color-accent-ink); text-decoration: none; }
  .home-more a:active { color: var(--color-accent-hover); }
  .home-more a span { color: var(--muted); }

  /* ---- 404 ---- */
  .notfound { padding: 96px 0; }
  .notfound h1 {
    margin: 0; font-size: clamp(56px, 9vw, 96px); font-weight: 600; line-height: 1;
    letter-spacing: -0.03em; font-variant-numeric: tabular-nums;
  }
  .notfound p { margin: 16px 0 32px; color: var(--muted); max-width: 52ch; }

  @media (max-width: 960px) {
    .home-hero { grid-template-columns: minmax(0, 1fr); gap: 40px; padding: 48px 0; }
    .home-duo, .home-split, .home-band, .home-end { grid-template-columns: minmax(0, 1fr); gap: 32px; }
    .home-end { padding: 40px; }
    .home-proof { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .home-proof li:nth-child(odd) { border-left: 0; }
    .home-proof li:nth-child(n + 3) { border-top: 1px solid var(--line); }
    .home-swap-list, .home-vs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .home-bars-grid { grid-template-columns: minmax(0, 1fr); }
    .home-play iframe { height: 880px; }
  }
  @media (max-width: 620px) {
    .home-section, .home-band, .home-swap { margin-bottom: 64px; }
    .home-proof-note { margin-bottom: 32px; }
    .home-swap-list, .home-vs { grid-template-columns: minmax(0, 1fr); }
    .home-bars { padding: 20px 16px; }
    .home-band { padding: 56px 0; }
    .home-end { padding: 28px 20px; margin-bottom: 32px; }
    .home-actions .install-widget, .home-actions .button { width: 100%; }
    .home-proof li { padding: 20px 16px; }
    .demo-screen { padding: 16px; }
    .demo-line { margin: 0 -16px; padding: 0 16px; font-size: 12px; }
    .demo-step, .demo-replay { padding: 0 12px; }
    .demo-step b { display: none; }
    .home-runtimes li { grid-template-columns: 88px minmax(0, 1fr); }
    .home-fw-tabs label { padding: 0 12px; }
  }
  @media (max-width: 360px) {
    .demo-step, .demo-replay { padding: 0 8px; letter-spacing: 0.03em; }
  }
`.trim()

// No-FOUC theme init + delegated toggle. The IIFE sets `data-theme` on <html> before the body paints
// (reads localStorage, falls back to the OS preference); the delegated click handler flips + persists it.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('nifra-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('#theme-toggle');if(!b)return;var n=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('nifra-theme',n);}catch(e){}});`

// The playground embed (/play?embed=1 inside the home page's <iframe>), same origin both ways.
// In the frame: mark the document before it paints (no chrome flash) and report its height. In the
// host: size the frame to that height. Both: follow a theme change made in the other document.
const EMBED_SCRIPT = `(function(){var d=document.documentElement;
if(location.pathname.indexOf('/play')===0&&location.search.indexOf('embed')>0){d.classList.add('play-embed');
if(parent!==window&&'ResizeObserver' in window)document.addEventListener('DOMContentLoaded',function(){var m=document.querySelector('main');if(!m)return;new ResizeObserver(function(){parent.postMessage({nifraPlayHeight:m.offsetHeight},location.origin);}).observe(m);});}
addEventListener('message',function(e){var f=document.querySelector('.home-play iframe');if(!f||e.origin!==location.origin||e.source!==f.contentWindow||!e.data||typeof e.data.nifraPlayHeight!=='number')return;f.style.height=Math.ceil(e.data.nifraPlayHeight)+'px';});
addEventListener('storage',function(e){if(e.key==='nifra-theme'&&e.newValue)d.setAttribute('data-theme',e.newValue);});})();`

export default function Layout(props: { children?: ReactNode }) {
  return (
    <div id="app">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, static, build-time theme bootstrap. */}
      <script dangerouslySetInnerHTML={{ __html: `${THEME_SCRIPT}\n${EMBED_SCRIPT}` }} />
      <style>{`${fonts.css}\n${css}`}</style>
      <div className="site-atmosphere" aria-hidden="true" />
      <header className="site">
        <div className="wrap">
          <a href="/" className="logo" aria-label="Nifra home" rel="external">
            <img className="logo-mark" src="/assets/logo-mark.png" alt="" width={28} height={28} />
            Nifra
            <span className="logo-badge">Built in Nifra</span>
          </a>
          <nav className="top" aria-label="Primary navigation">
            <a href="/docs">Docs</a>
            <a href="/play">Playground</a>
            <a href="/frameworks">Frameworks</a>
            <a href="/benchmarks">Benchmarks</a>
            <a href="/blog">Blog</a>
            <a href="/docs/security">Security</a>
            <a
              className="icon-link"
              href="https://github.com/nifrajs/nifra"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Nifra on GitHub"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.76.41-1.27.74-1.56-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
              </svg>
              <span className="sr-only">GitHub</span>
            </a>
            <a
              className="icon-link"
              href="https://www.npmjs.com/package/nifra"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Nifra on npm"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M0 7.334v8h6.666v1.334H12v-1.334h12v-8zm6.666 6.665H5.334v-4H3.999v4H1.335V8.667h5.331zm4 0v1.336H8.001V8.667h5.334v5.332h-2.669zm12.001 0h-1.33v-4h-1.336v4h-1.335v-4h-1.33v4h-2.671V8.667h8.002z" />
              </svg>
              <span className="sr-only">npm</span>
            </a>
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
          <span>Proudly built with Nifra - server-rendered on Cloudflare Pages.</span>
          <span className="foot-links">
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
            <a href="/agents.md">Agents</a>
            <a href="/frameworks">Frameworks</a>
            <a href="/blog">Blog</a>
            <a href="/compare">Compare</a>
            <a href="https://github.com/nifrajs/nifra" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href="https://www.npmjs.com/package/nifra" target="_blank" rel="noopener noreferrer">
              npm
            </a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <span>MIT</span>
          </span>
        </div>
      </footer>

      <script type="module" src="/assets/nifra-bot.client.js?v=7" />
    </div>
  )
}
