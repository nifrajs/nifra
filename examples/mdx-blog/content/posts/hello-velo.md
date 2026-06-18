---
title: Hello, nifra
date: 2026-06-01
summary: A content-collection post authored in Markdown, rendered with <Content/>.
---

# Hello, nifra

This post lives in `content/posts/*.md`. `defineCollection` parses it, **validates** the frontmatter
against a schema, and renders the Markdown to HTML — which the page drops in with
`<Content html={post.html} />`.

This particular build runs on **Solid**, but the content layer is identical on all five frameworks.
