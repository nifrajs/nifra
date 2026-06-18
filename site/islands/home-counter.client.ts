/**
 * Homepage enhancer bundle — the only client JS the (static, `hydrate: false`) homepage ships:
 * a copy button for the install command. A few hundred bytes of vanilla DOM, no framework runtime.
 * Loaded via the route's `islandScripts`.
 */
function enhanceCopyButtons(): void {
  for (const button of document.querySelectorAll("[data-copy-command]")) {
    if (!(button instanceof HTMLButtonElement)) continue
    button.addEventListener("click", async () => {
      const command = button.dataset.copyCommand
      if (command === undefined) return
      try {
        await navigator.clipboard.writeText(command)
        button.dataset.copied = "true"
        window.setTimeout(() => {
          delete button.dataset.copied
        }, 2000)
      } catch {
        delete button.dataset.copied // clipboard denied — leave the button idle
      }
    })
  }
}

enhanceCopyButtons()
