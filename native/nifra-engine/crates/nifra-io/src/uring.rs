//! Linux 6.1+ `io_uring` (`IORING_SETUP_DEFER_TASKRUN` + registered `eventfd`) transport hooks
//! with automatic fallback to `libuv-poll` when the kernel does not support `io_uring`.

#![cfg(target_os = "linux")]

use std::io;

#[derive(Debug, Clone, Copy)]
pub struct UringConfig {
    pub ring_entries: u32,
    pub defer_taskrun: bool,
    pub single_issuer: bool,
}

impl Default for UringConfig {
    fn default() -> Self {
        Self {
            ring_entries: 4096,
            defer_taskrun: true,
            single_issuer: true,
        }
    }
}

/// Probe whether the running Linux kernel supports `io_uring` with `SINGLE_ISSUER` / `DEFER_TASKRUN`.
pub fn probe_uring_support(cfg: UringConfig) -> io::Result<bool> {
    let mut builder: io_uring::Builder = io_uring::IoUring::builder();
    if cfg.single_issuer {
        builder.setup_single_issuer();
    }
    if cfg.defer_taskrun {
        builder.setup_defer_taskrun();
    }
    match builder.build(cfg.ring_entries.min(64)) {
        Ok(_) => Ok(true),
        // The requested setup flags are unsupported: a plain ring would not honour them.
        Err(_) => Ok(false),
    }
}
