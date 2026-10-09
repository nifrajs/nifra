---
"@nifrajs/web": patch
---

The server-component HTML check accepts `<!>`, the comment marker Solid's templates (and `<!$>`, `<!/>`) use, which every browser reads as a comment. Under Trusted Types the component policy checks every HTML string a page assigns, and it refused Solid's own templates, so a Solid page with components never hydrated. Other malformed markup, `<?...>` and `<![CDATA[` among it, is still refused.
