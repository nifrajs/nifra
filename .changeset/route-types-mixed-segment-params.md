---
"@nifrajs/web": patch
---

`nifra types` gives a route file with a part-literal segment, such as `routes/post-[id].tsx` or `routes/[year]-[month].xml.tsx`, the params inside that segment. Its `Params` was `Record<string, never>` although the route matches `/post-:id` and its loader receives `params.id`.
