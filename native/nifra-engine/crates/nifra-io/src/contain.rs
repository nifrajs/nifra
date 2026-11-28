//! Keeps a panic in protocol or handler code on the connection that raised it.
//!
//! The release profile unwinds, but an unwind that reaches libuv's `extern "C"` frame still aborts
//! the process, so it is caught here, around every call the transports make into their handler.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use crate::uv::UvCallbacks;
use crate::ConnAction;

pub(crate) struct Contained(pub(crate) Box<dyn UvCallbacks>);

fn contain<R>(fallback: R, run: impl FnOnce() -> R) -> R {
    catch_unwind(AssertUnwindSafe(run)).unwrap_or(fallback)
}

// Every method is forwarded: a missed one would silently use the trait's default.
impl UvCallbacks for Contained {
    fn on_h2_negotiated(&mut self, conn_id: u32) {
        contain((), || self.0.on_h2_negotiated(conn_id));
    }
    fn on_data(&mut self, conn_id: u32, read_buf: &[u8], write_buf: &mut Vec<u8>) -> ConnAction {
        contain(ConnAction::CloseNow, || {
            self.0.on_data(conn_id, read_buf, write_buf)
        })
    }
    fn on_turn_end(&mut self) {
        contain((), || self.0.on_turn_end());
    }
    fn has_pending_requests(&self, conn_id: u32) -> bool {
        contain(false, || self.0.has_pending_requests(conn_id))
    }
    fn without_pending(&self, ids: Vec<u32>) -> Vec<u32> {
        contain(Vec::new(), || self.0.without_pending(ids))
    }
    fn unanswered_only(&self, conn_id: u32) -> bool {
        contain(false, || self.0.unanswered_only(conn_id))
    }
    fn expire_requests(&mut self, conn_id: u32, now: Instant, out: &mut Vec<u8>) -> bool {
        contain(true, || self.0.expire_requests(conn_id, now, out))
    }
    fn reads_http1(&self, conn_id: u32) -> bool {
        contain(true, || self.0.reads_http1(conn_id))
    }
    fn oldest_incomplete_head(&self, conn_id: u32) -> Option<Instant> {
        contain(None, || self.0.oldest_incomplete_head(conn_id))
    }
    fn output_stalled_since(&self, conn_id: u32) -> Option<Instant> {
        contain(None, || self.0.output_stalled_since(conn_id))
    }
    fn probe_idle(&self, conn_id: u32) -> bool {
        contain(false, || self.0.probe_idle(conn_id))
    }
    fn is_websocket(&self, conn_id: u32) -> bool {
        contain(false, || self.0.is_websocket(conn_id))
    }
    fn flush_aborted(&mut self) {
        contain((), || self.0.flush_aborted());
    }
    fn on_writable(&mut self, conn_id: u32) {
        contain((), || self.0.on_writable(conn_id));
    }
    fn on_disconnect(&mut self, conn_id: u32) {
        contain((), || self.0.on_disconnect(conn_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Panics;

    impl UvCallbacks for Panics {
        fn on_data(&mut self, _: u32, _: &[u8], _: &mut Vec<u8>) -> ConnAction {
            panic!("on_data")
        }
        fn on_turn_end(&mut self) {
            panic!("on_turn_end")
        }
        fn has_pending_requests(&self, _: u32) -> bool {
            panic!("has_pending_requests")
        }
        fn expire_requests(&mut self, _: u32, _: Instant, _: &mut Vec<u8>) -> bool {
            panic!("expire_requests")
        }
        fn on_writable(&mut self, _: u32) {
            panic!("on_writable")
        }
        fn on_disconnect(&mut self, _: u32) {
            panic!("on_disconnect")
        }
    }

    #[test]
    fn a_panicking_handler_closes_the_connection_and_stays_usable() {
        let mut handler = Contained(Box::new(Panics));
        let mut out = Vec::new();
        for _ in 0..2 {
            assert!(matches!(
                handler.on_data(1, b"x", &mut out),
                ConnAction::CloseNow
            ));
        }
        assert!(handler.expire_requests(1, Instant::now(), &mut out));
        assert!(!handler.has_pending_requests(1));
        handler.on_turn_end();
        handler.on_writable(1);
        handler.on_disconnect(1);
    }
}
