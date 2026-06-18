// A module that fails at load time (NOT a resolution failure) — fixture for `requirePeer`'s
// "installed but failed to load" branch.
throw new Error("boom at module load")
