---
"@nifrajs/pi": patch
"@nifrajs/acp": patch
---

`PiBackend` masks the credentials it hands the Pi process wherever a model or extension error echoes one: every value from the provider environment and from `env`, apart from the base `PATH`/`HOME`/locale variables, becomes `[REDACTED]` in the error a turn rejects with and in its `session.failed` event, whatever the key looks like. The key-shape fallback in Pi and ACP also recognizes Groq (`gsk_`), xAI (`xai-`), Hugging Face (`hf_`) and NVIDIA (`nvapi-`) keys.
