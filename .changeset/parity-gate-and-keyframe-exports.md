---
"@nifrajs/web": minor
---

A dev/prod parity gate, and the CSS Modules divergence it immediately found.

nifra runs two pipelines and each is internally coherent: dev is Vite end to end, production is Bun end
to end. That split is deliberate. What is not acceptable is the two regimes disagreeing about a fact an
app depends on, because that failure always presents the same way - as "it worked locally", discovered
after a deploy. The gate builds one fixture app through both pipelines and asserts they agree on four
facts, each of which is a bug that already shipped or the mechanism behind one: the served `public/` set
(byte-for-byte, not just the path list), that a module imported by two routes stays one module, CSS
Modules behaviour, and the route manifest.

Scoped CSS class names are deliberately not compared. A scoped name never crosses the regime boundary,
since each regime compiles both of its own halves, so requiring equal hashes would freeze both naming
schemes forever while proving nothing. What is compared is the contract: the same exported keys, every
one actually scoped, and `:global` left alone on both sides.

That comparison found a real divergence on its first run. `@keyframes` names are part of the CSS Modules
export namespace - postcss-modules exports them, so Vite does, so nifra's dev pipeline did - but the Bun
plugin omitted them. `styles.spin` was therefore a usable scoped name in dev and `undefined` in
production, with no error at either end. Keyframe names are now exported, so anything reaching for one
(`style={{ animationName: styles.spin }}`) behaves the same in both.

When a file has both a class and a keyframe under one name, the class wins the export. That resolution is
fixed by construction rather than by declaration order, because a name that has to agree across two
pipelines cannot depend on which rule was seen first; the keyframe stays scoped in the stylesheet under
its own distinctly salted name either way.

`createViteDevServer` also now reports the port it actually bound rather than the one it was asked for.
They differ for `port: 0` - the way to ask the OS for a free port, and what a test or a second app wants -
where it previously echoed back a literal `0`, which connects to nothing.
