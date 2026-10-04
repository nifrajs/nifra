---
"@nifrajs/pi": patch
---

`PiBackend` passes the model-provider credential variables Pi reads (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and the AWS and Google Cloud credentials) through to Pi, so a key set in the environment works without listing it in `env`. Other parent variables still stay out, and `env: { NAME: undefined }` withholds any of them.
