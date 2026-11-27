//! Linux `io_uring` transport backend multiplexed inside Node.js's `uv_loop_t` via a single
//! registered `eventfd` watched by `uv_poll_t`, sharing `ConnCore` / `ConnSlab` with `epoll`
//! and falling back cleanly if the kernel restricts `io_uring_setup`.

#![cfg(target_os = "linux")]

use std::cell::RefCell;
use std::ffi::{c_int, c_void};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd, RawFd};
use std::rc::Rc;
use std::sync::Arc;

use io_uring::{opcode, squeue, types, IoUring};
use nifra_tls::{feed_ciphertext, TlsError, TlsInput, TlsStore};

use crate::sys::{
    accept_and_discard, accept_nonblock, alloc_handle, alloc_read_scratch, as_raw_sock, close_sock,
    collect_timeouts, configure_accepted_socket, ensure_read_scratch, flush_write_buf_core,
    free_handle, into_raw_sock, is_valid_sock, last_recv_error, open_spare_fd, recv_nonblock,
    set_tcp_nodelay, uv_api, write_buf_limit, write_bytes_or_queue, AcceptOutcome, ConnCore,
    ConnSlab, FlushAction, LoopClock, OwnedSock, RawSock, RecvErrKind, UvApi,
    DATE_TICK_INTERVAL_MS, INVALID_SOCK, MAX_READ_PER_EVENT, MAX_WRITE_BUF_BYTES,
    READ_SCRATCH_SIZE, SHRINK_THRESHOLD, UV_READABLE, WS_PING_FRAME,
};
use crate::uv::{UvCallbacks, WriteResult};
use crate::{ConnAction, SocketConfig};

const LISTENER_EVENT_ID: u64 = 0;
const LISTENER_CANCEL_EVENT_ID: u64 = 1;
const CANCEL_EVENT_ID: u64 = u64::MAX;

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
            defer_taskrun: false,
            single_issuer: true,
        }
    }
}

fn build_ring(cfg: UringConfig, probe_only: bool) -> io::Result<IoUring> {
    let entries = if probe_only {
        cfg.ring_entries.min(64)
    } else {
        cfg.ring_entries.max(256)
    };
    let mut builder = IoUring::builder();
    if cfg.single_issuer {
        builder.setup_single_issuer();
    }
    if cfg.defer_taskrun {
        builder.setup_defer_taskrun();
    }
    match builder.build(entries) {
        Ok(ring) => Ok(ring),
        Err(_) => IoUring::new(entries.min(2048)),
    }
}

/// Probe whether the running Linux kernel supports `io_uring` + `eventfd` registration with the
/// same setup fallback policy used at server startup.
pub fn probe_uring_support(cfg: UringConfig) -> io::Result<bool> {
    Ok(init_uring_with_config(cfg).is_ok())
}

#[inline]
const fn poll_user_data(conn_id: u32, poll_seq: u32) -> u64 {
    ((poll_seq as u64) << 32) | (conn_id as u64)
}

#[inline]
fn desired_poll_mask(core: &ConnCore) -> u32 {
    let mut mask = 0u32;
    if !(core.read_ended || core.is_read_paused()) {
        mask |= libc::POLLIN as u32;
    }
    if core.writable_armed {
        mask |= libc::POLLOUT as u32;
    }
    mask
}

#[inline]
fn push_sqe(ring: &mut IoUring, entry: squeue::Entry) -> io::Result<()> {
    // SAFETY: PollAdd/PollRemove hold no user pointers that outlive CQ completion.
    if unsafe { ring.submission().push(&entry) }.is_err() {
        ring.submit()?;
        if unsafe { ring.submission().push(&entry) }.is_err() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "io_uring submission queue full",
            ));
        }
    }
    Ok(())
}

#[inline]
fn sync_conn_poll(
    ring: Option<&mut IoUring>,
    conn: &mut UringConn,
    conn_id: u32,
    force_rearm: bool,
) -> bool {
    let Some(ring) = ring else {
        return false;
    };
    let desired = desired_poll_mask(&conn.core);
    if !force_rearm && conn.armed_mask == desired {
        return true;
    }
    if conn.armed_mask != 0 {
        let old_ud = poll_user_data(conn_id, conn.poll_seq);
        if push_sqe(
            ring,
            opcode::PollRemove::new(old_ud)
                .build()
                .user_data(CANCEL_EVENT_ID),
        )
        .is_err()
        {
            return false;
        }
        conn.armed_mask = 0;
    }
    conn.poll_seq = conn.poll_seq.wrapping_add(1).max(1);
    if desired != 0 {
        let new_ud = poll_user_data(conn_id, conn.poll_seq);
        let entry = opcode::PollAdd::new(types::Fd(conn.core.fd), desired)
            .build()
            .user_data(new_ud);
        if push_sqe(ring, entry).is_err() {
            return false;
        }
        conn.armed_mask = desired;
    }
    true
}

struct UringConn {
    core: ConnCore,
    poll_seq: u32,
    armed_mask: u32,
}

struct UringCtx {
    state: Rc<RefCell<UringState>>,
    evfd: RawFd,
}

struct CheckCtx {
    state: Rc<RefCell<UringState>>,
}

struct TimerCtx {
    state: Rc<RefCell<UringState>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ListenerCancel {
    Unqueued,
    Queued,
    Submitted,
}

struct UringState {
    uv: &'static UvApi,
    uv_loop: *mut c_void,
    is_tcp: bool,
    cfg: SocketConfig,
    tls: Option<Arc<TlsStore>>,
    clock: LoopClock,
    ring: Option<IoUring>,
    evfd: RawFd,
    listener_fd: RawSock,
    listener_armed: bool,
    listener_stopping: bool,
    listener_cancel: ListenerCancel,
    unix_guard: Option<crate::UnixSocketGuard>,
    uring_handle: *mut c_void,
    check_handle: *mut c_void,
    check_armed: bool,
    timer_handle: *mut c_void,
    conns: ConnSlab<UringConn>,
    read_ended: Vec<u32>,
    pending_disconnects: Vec<u32>,
    pending_writable: Vec<u32>,
    turn_dirty: bool,
    in_poll_loop: bool,
    closed: bool,
    read_scratch: Vec<MaybeUninit<u8>>,
    scratch_write: Vec<u8>,
    cqe_scratch: Vec<(u64, i32)>,
    spare_fd: RawSock,
    dispatching: Option<u32>,
    deferred: Vec<u8>,
    deferred_close: bool,
    deferred_bp: bool,
    callbacks: Option<Box<dyn UvCallbacks>>,
}

impl UringState {
    #[inline]
    fn arm_check(&mut self) {
        if !self.closed && !self.check_armed && !self.check_handle.is_null() {
            self.check_armed = true;
            unsafe { (self.uv.check_start)(self.check_handle, on_check_event) };
        }
    }

    #[inline]
    fn submit_ring(&mut self) {
        if let Some(ref mut ring) = self.ring {
            let _ = ring.submit();
        }
    }

    #[inline]
    fn arm_listener(&mut self) -> io::Result<()> {
        if !self.listener_stopping && is_valid_sock(self.listener_fd) && !self.listener_armed {
            let Some(ref mut ring) = self.ring else {
                return Err(io::Error::other("io_uring ring has already closed"));
            };
            let entry = opcode::PollAdd::new(types::Fd(self.listener_fd), libc::POLLIN as u32)
                .build()
                .user_data(LISTENER_EVENT_ID);
            push_sqe(ring, entry)?;
            self.listener_armed = true;
        }
        Ok(())
    }

    fn release_listener(&mut self) {
        if is_valid_sock(self.listener_fd) {
            unsafe { close_sock(self.listener_fd) };
            self.listener_fd = INVALID_SOCK;
        }
    }

    fn cancel_listener_poll(&mut self) {
        let Some(ring) = self.ring.as_mut().filter(|_| self.listener_armed) else {
            self.release_listener();
            return;
        };
        if self.listener_cancel == ListenerCancel::Unqueued {
            let entry = opcode::PollRemove::new(LISTENER_EVENT_ID)
                .build()
                .user_data(LISTENER_CANCEL_EVENT_ID);
            if push_sqe(ring, entry).is_err() {
                return;
            }
            self.listener_cancel = ListenerCancel::Queued;
        }
        // The timer retries after enqueue or submit failures. The original poll's completion
        // releases the fd because the kernel may still hold the socket after a successful submit.
        if self.listener_cancel == ListenerCancel::Queued
            && ring.submit().is_ok()
            && ring.submission().is_empty()
        {
            self.listener_cancel = ListenerCancel::Submitted;
        }
    }

    fn remove_and_close_conn(&mut self, conn_id: u32) -> bool {
        let Some(conn) = self.conns.remove(conn_id) else {
            return false;
        };
        if conn.armed_mask != 0 {
            if let Some(ref mut ring) = self.ring {
                let _ = push_sqe(
                    ring,
                    opcode::PollRemove::new(poll_user_data(conn_id, conn.poll_seq))
                        .build()
                        .user_data(CANCEL_EVENT_ID),
                );
                let _ = ring.submit();
            }
        }
        unsafe { close_sock(conn.core.fd) };
        self.pending_disconnects.push(conn_id);
        if !self.in_poll_loop {
            self.arm_check();
        }
        true
    }
}

#[derive(Clone)]
pub struct UringServer {
    state: Rc<RefCell<UringState>>,
}

fn init_uring_with_config(cfg: UringConfig) -> io::Result<(IoUring, OwnedFd)> {
    use std::os::fd::FromRawFd;
    let ring = build_ring(cfg, false)?;
    let raw_evfd = unsafe { libc::eventfd(0, libc::EFD_NONBLOCK | libc::EFD_CLOEXEC) };
    if raw_evfd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `eventfd` returned a fresh owned file descriptor.
    let evfd = unsafe { OwnedFd::from_raw_fd(raw_evfd) };
    ring.submitter().register_eventfd(evfd.as_raw_fd())?;
    Ok((ring, evfd))
}

/// Initialize the `IoUring` and registered `eventfd` before consuming the listener/callbacks so callers can cleanly fall back to `epoll`.
pub(crate) fn init_uring_ring() -> io::Result<(IoUring, OwnedFd)> {
    init_uring_with_config(UringConfig::default())
}

impl UringServer {
    /// # Safety
    /// `uv_loop` must point to the live `uv_loop_t` of the calling thread and outlive the server.
    #[allow(clippy::too_many_arguments)]
    pub(crate) unsafe fn start_fd_with_tls(
        uv_loop: *mut c_void,
        listener: OwnedSock,
        is_tcp: bool,
        unix_guard: Option<crate::UnixSocketGuard>,
        cfg: SocketConfig,
        tls: Option<Arc<TlsStore>>,
        callbacks: Box<dyn UvCallbacks>,
        ring_and_evfd: Option<(IoUring, OwnedFd)>,
    ) -> io::Result<Self> {
        if uv_loop.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "null uv_loop_t pointer",
            ));
        }
        let uv = uv_api()?;
        let (ring, evfd_owned) = match ring_and_evfd {
            Some(pair) => pair,
            None => init_uring_ring()?,
        };
        let evfd_raw = evfd_owned.as_raw_fd();

        let uring_handle = alloc_handle(uv.poll_size);
        let rc = (uv.poll_init_socket)(uv_loop, uring_handle, evfd_raw);
        if rc != 0 {
            free_handle(uring_handle, uv.poll_size);
            return Err(io::Error::other(format!(
                "uv_poll_init_socket(eventfd) failed: {rc}"
            )));
        }

        let check_handle = alloc_handle(uv.check_size);
        let rc = (uv.check_init)(uv_loop, check_handle);
        if rc != 0 {
            free_handle(check_handle, uv.check_size);
            let ctx = Box::into_raw(Box::new(evfd_owned));
            (uv.handle_set_data)(uring_handle, ctx.cast());
            (uv.close)(uring_handle, on_owned_fd_poll_close);
            return Err(io::Error::other(format!("uv_check_init failed: {rc}")));
        }

        let listener_fd = as_raw_sock(&listener);
        if is_tcp && cfg.tcp_nodelay {
            set_tcp_nodelay(listener_fd);
        }
        let owned_listener = into_raw_sock(listener);
        let initial_uv_ms = (uv.now)(uv_loop);

        let state = Rc::new(RefCell::new(UringState {
            uv,
            uv_loop,
            is_tcp,
            cfg,
            tls,
            clock: LoopClock::new(initial_uv_ms),
            ring: Some(ring),
            evfd: evfd_raw,
            listener_fd: owned_listener,
            listener_armed: false,
            listener_stopping: false,
            listener_cancel: ListenerCancel::Unqueued,
            unix_guard,
            uring_handle,
            check_handle,
            check_armed: false,
            timer_handle: std::ptr::null_mut(),
            conns: ConnSlab::with_capacity(256),
            read_ended: Vec::new(),
            pending_disconnects: Vec::new(),
            pending_writable: Vec::new(),
            turn_dirty: false,
            in_poll_loop: false,
            closed: false,
            read_scratch: alloc_read_scratch(),
            scratch_write: Vec::with_capacity(16 * 1024),
            cqe_scratch: Vec::with_capacity(512),
            spare_fd: open_spare_fd(),
            dispatching: None,
            deferred: Vec::new(),
            deferred_close: false,
            deferred_bp: false,
            callbacks: Some(callbacks),
        }));

        let u_ctx = Box::into_raw(Box::new(UringCtx {
            state: Rc::clone(&state),
            evfd: evfd_owned.into_raw_fd(),
        }));
        (uv.handle_set_data)(uring_handle, u_ctx.cast());

        let c_ctx = Box::into_raw(Box::new(CheckCtx {
            state: Rc::clone(&state),
        }));
        (uv.handle_set_data)(check_handle, c_ctx.cast());

        {
            let mut st = state.borrow_mut();
            if let Err(err) = st.arm_listener() {
                drop(st);
                Self {
                    state: Rc::clone(&state),
                }
                .close_all();
                return Err(err);
            }
            if let Some(ref mut r) = st.ring {
                if let Err(err) = r.submit() {
                    drop(st);
                    Self {
                        state: Rc::clone(&state),
                    }
                    .close_all();
                    return Err(err);
                }
            }
        }

        let th = alloc_handle(uv.timer_size);
        let timer_handle = if (uv.timer_init)(uv_loop, th) == 0 {
            let t_ctx = Box::into_raw(Box::new(TimerCtx {
                state: Rc::clone(&state),
            }));
            (uv.handle_set_data)(th, t_ctx.cast());
            (uv.unref)(th);
            let _ = (uv.timer_start)(
                th,
                on_timer_event,
                DATE_TICK_INTERVAL_MS,
                DATE_TICK_INTERVAL_MS,
            );
            th
        } else {
            free_handle(th, uv.timer_size);
            std::ptr::null_mut()
        };
        state.borrow_mut().timer_handle = timer_handle;

        let rc = (uv.poll_start)(uring_handle, UV_READABLE, on_uring_event);
        if rc != 0 {
            let srv = Self { state };
            srv.close_all();
            return Err(io::Error::other(format!(
                "uv_poll_start(eventfd) failed: {rc}"
            )));
        }

        Ok(Self { state })
    }

    pub fn reload_tls(&self, input: &TlsInput) -> Result<(), TlsError> {
        let store = {
            let st = self.state.borrow();
            if st.closed {
                return Err(TlsError::MissingMaterial);
            }
            st.tls.clone()
        };
        let Some(store) = store else {
            return Err(TlsError::MissingMaterial);
        };
        store.reload_input(input)
    }

    pub fn add_server_name(&self, entry: nifra_tls::SniCertInput) -> Result<(), TlsError> {
        let store = {
            let st = self.state.borrow();
            if st.closed {
                return Err(TlsError::MissingMaterial);
            }
            st.tls.clone()
        };
        let Some(store) = store else {
            return Err(TlsError::MissingMaterial);
        };
        store.add_server_name(entry)
    }

    pub fn remove_server_name(&self, server_name: &str) -> Result<bool, TlsError> {
        let store = {
            let st = self.state.borrow();
            if st.closed {
                return Err(TlsError::MissingMaterial);
            }
            st.tls.clone()
        };
        let Some(store) = store else {
            return Ok(false);
        };
        store.remove_server_name(server_name)
    }

    pub fn remote_addr(&self, conn_id: u32) -> Option<String> {
        self.state
            .borrow()
            .conns
            .get(conn_id)
            .map(|c| c.core.peer_ip.map_or_else(String::new, |ip| ip.to_string()))
    }

    pub fn has_read_ended(&self, conn_id: u32) -> bool {
        self.state
            .borrow()
            .conns
            .get(conn_id)
            .is_some_and(|c| c.core.read_ended && !c.core.dispatching)
    }

    pub fn alpn_protocol(&self, conn_id: u32) -> Option<Vec<u8>> {
        self.state
            .borrow()
            .conns
            .get(conn_id)
            .and_then(|c| c.core.alpn_protocol())
    }

    pub fn write_to_conn(
        &self,
        conn_id: u32,
        bytes: &[u8],
        close_after: bool,
        close_if_read_ended: bool,
    ) -> WriteResult {
        let mut st = self.state.borrow_mut();
        let uv = st.uv;
        let now = if st.in_poll_loop {
            st.clock.now()
        } else {
            let uv_ms = unsafe { (uv.now)(st.uv_loop) };
            st.clock.tick(uv_ms)
        };
        let max_write = write_buf_limit(st.cfg);
        if st.dispatching == Some(conn_id) {
            if let Some(conn) = st.conns.get(conn_id) {
                let effective_close = close_after
                    || (close_if_read_ended && conn.core.read_ended && !conn.core.dispatching);
                let next_len = st.deferred.len().saturating_add(bytes.len());
                if next_len > max_write.max(MAX_WRITE_BUF_BYTES) {
                    st.remove_and_close_conn(conn_id);
                    st.submit_ring();
                    return WriteResult::Closed;
                }
                st.deferred.extend_from_slice(bytes);
                st.deferred_close |= effective_close;
                if next_len > (max_write / 2).max(1) {
                    st.deferred_bp = true;
                    return WriteResult::Backpressured;
                }
                return WriteResult::Written;
            }
        }
        let st_ref = &mut *st;
        let Some(conn) = st_ref.conns.get_mut(conn_id) else {
            return WriteResult::Closed;
        };
        conn.core.last_activity = now;
        let read_ended = conn.core.read_ended;
        let effective_close =
            close_after || (close_if_read_ended && read_ended && !conn.core.dispatching);
        if conn.core.queued_bytes() >= max_write
            && (conn.core.cork_depth == 0 || conn.core.writable_armed)
        {
            st_ref.remove_and_close_conn(conn_id);
            st_ref.submit_ring();
            return WriteResult::Closed;
        }
        if effective_close {
            conn.core.close_after_write = true;
        }
        let fa = write_bytes_or_queue(&mut conn.core, bytes, max_write);
        if fa == FlushAction::Close || conn.core.queued_bytes() > max_write {
            st_ref.remove_and_close_conn(conn_id);
            st_ref.submit_ring();
            return WriteResult::Closed;
        }
        let armed = conn.core.writable_armed;
        if fa != FlushAction::None {
            if !sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, false) {
                st_ref.remove_and_close_conn(conn_id);
                st_ref.submit_ring();
                return WriteResult::Closed;
            }
            st_ref.submit_ring();
        }
        if fa == FlushAction::DisarmWritable {
            st_ref.pending_writable.push(conn_id);
            if !st_ref.in_poll_loop {
                st_ref.arm_check();
            }
        }
        if read_ended {
            st_ref.turn_dirty = true;
            if !st_ref.in_poll_loop {
                st_ref.arm_check();
            }
        }
        if armed {
            WriteResult::Backpressured
        } else {
            WriteResult::Written
        }
    }

    pub fn close_conn(&self, conn_id: u32) -> bool {
        let mut st = self.state.borrow_mut();
        let closed = st.remove_and_close_conn(conn_id);
        if closed {
            st.submit_ring();
        }
        closed
    }

    pub fn cork_begin(&self, conn_id: u32) -> bool {
        let mut st = self.state.borrow_mut();
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return false;
        };
        conn.core.cork_depth = conn.core.cork_depth.saturating_add(1);
        true
    }

    pub fn cork_end(&self, conn_id: u32) -> WriteResult {
        let mut st = self.state.borrow_mut();
        let st_ref = &mut *st;
        let Some(conn) = st_ref.conns.get_mut(conn_id) else {
            return WriteResult::Closed;
        };
        conn.core.cork_depth = conn.core.cork_depth.saturating_sub(1);
        if conn.core.cork_depth > 0 {
            return if conn.core.writable_armed {
                WriteResult::Backpressured
            } else {
                WriteResult::Written
            };
        }
        if conn.core.queued_bytes() == 0 && !conn.core.close_after_write {
            return if conn.core.writable_armed {
                WriteResult::Backpressured
            } else {
                WriteResult::Written
            };
        }
        let fa = flush_write_buf_core(&mut conn.core);
        if fa == FlushAction::Close {
            st_ref.remove_and_close_conn(conn_id);
            st_ref.submit_ring();
            return WriteResult::Closed;
        }
        let armed = conn.core.writable_armed;
        if fa != FlushAction::None {
            if !sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, false) {
                st_ref.remove_and_close_conn(conn_id);
                st_ref.submit_ring();
                return WriteResult::Closed;
            }
            st_ref.submit_ring();
        }
        if fa == FlushAction::DisarmWritable {
            st_ref.pending_writable.push(conn_id);
            if !st_ref.in_poll_loop {
                st_ref.arm_check();
            }
        }
        if armed {
            WriteResult::Backpressured
        } else {
            WriteResult::Written
        }
    }

    pub fn close_within(&self, conn_id: u32, wait: std::time::Duration) {
        let mut st = self.state.borrow_mut();
        let at = st.clock.now() + wait;
        if let Some(conn) = st.conns.get_mut(conn_id) {
            conn.core.close_deadline = Some(at);
        }
    }

    pub fn any_queued(&self) -> bool {
        let st = self.state.borrow();
        !st.deferred.is_empty() || st.conns.iter().any(|(_, c)| c.core.queued_bytes() > 0)
    }

    pub fn queued_bytes(&self, conn_id: u32) -> usize {
        self.queued_bytes_for(conn_id, true)
    }

    pub(crate) fn queued_bytes_for(&self, conn_id: u32, include_corked: bool) -> usize {
        let st = self.state.borrow();
        let deferred = if st.dispatching == Some(conn_id) {
            st.deferred.len()
        } else {
            0
        };
        st.conns.get(conn_id).map_or(deferred, |c| {
            c.core
                .queued_output(deferred, st.deferred_bp, include_corked)
        })
    }

    pub fn set_read_paused(&self, conn_id: u32, paused: bool) -> bool {
        let mut st = self.state.borrow_mut();
        let st_ref = &mut *st;
        let Some(conn) = st_ref.conns.get_mut(conn_id) else {
            return false;
        };
        if conn.core.app_read_paused == paused {
            return true;
        }
        conn.core.app_read_paused = paused;
        if !sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, false) {
            st_ref.remove_and_close_conn(conn_id);
            st_ref.submit_ring();
            return false;
        }
        st_ref.submit_ring();
        true
    }

    pub fn stop_listening(&self) {
        let mut st = self.state.borrow_mut();
        st.listener_stopping = true;
        st.cancel_listener_poll();
        if let Some(mut guard) = st.unix_guard.take() {
            guard.cleanup_now();
        }
    }

    pub fn close_all(&self) {
        self.stop_listening();
        let mut st = self.state.borrow_mut();
        if st.closed {
            return;
        }
        st.closed = true;
        st.clock.release_date_lease();
        let uv = st.uv;
        let mut ring = st.ring.take();
        if let Some(ref mut r) = ring {
            for (conn_id, conn) in st.conns.iter() {
                if conn.armed_mask != 0 {
                    let _ = push_sqe(
                        r,
                        opcode::PollRemove::new(poll_user_data(conn_id, conn.poll_seq))
                            .build()
                            .user_data(CANCEL_EVENT_ID),
                    );
                }
            }
            let _ = r.submit();
        }
        let drained = st.conns.drain();
        st.read_ended.clear();
        for conn in drained {
            unsafe { close_sock(conn.core.fd) };
        }
        drop(ring);
        st.release_listener();
        if !st.uring_handle.is_null() {
            let h = st.uring_handle;
            st.uring_handle = std::ptr::null_mut();
            st.evfd = -1;
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    (uv.poll_stop)(h);
                    (uv.close)(h, on_uring_close);
                }
            }
        }
        if !st.check_handle.is_null() {
            let h = st.check_handle;
            st.check_handle = std::ptr::null_mut();
            st.check_armed = false;
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    (uv.check_stop)(h);
                    (uv.close)(h, on_check_close);
                }
            }
        }
        if !st.timer_handle.is_null() {
            let h = st.timer_handle;
            st.timer_handle = std::ptr::null_mut();
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    (uv.timer_stop)(h);
                    (uv.close)(h, on_timer_close);
                }
            }
        }
        st.callbacks = None;
        if is_valid_sock(st.spare_fd) {
            unsafe { close_sock(st.spare_fd) };
            st.spare_fd = INVALID_SOCK;
        }
    }
}

unsafe fn accept_ready_uring(state_rc: &Rc<RefCell<UringState>>, now: std::time::Instant) {
    let mut st = state_rc.borrow_mut();
    if st.closed || !is_valid_sock(st.listener_fd) {
        return;
    }
    let nodelay = st.is_tcp && st.cfg.tcp_nodelay;
    loop {
        let listener_fd = st.listener_fd;
        let (client_fd, peer_ip) = match accept_nonblock(listener_fd) {
            AcceptOutcome::Accepted { sock, peer_ip } => (sock, peer_ip),
            AcceptOutcome::Emfile => {
                if is_valid_sock(st.spare_fd) {
                    close_sock(st.spare_fd);
                    accept_and_discard(listener_fd);
                    st.spare_fd = open_spare_fd();
                    continue;
                }
                break;
            }
            AcceptOutcome::Retry => continue,
            AcceptOutcome::WouldBlock => break,
        };
        if st.cfg.max_connections > 0 && st.conns.len() >= st.cfg.max_connections {
            close_sock(client_fd);
            continue;
        }
        let tls_conn = match &st.tls {
            Some(store) => match store.new_connection() {
                Ok(c) => Some(c),
                Err(_) => {
                    close_sock(client_fd);
                    continue;
                }
            },
            None => None,
        };
        configure_accepted_socket(client_fd, nodelay);
        let Some(conn_id) = st.conns.alloc_with(|_| UringConn {
            core: ConnCore::new(client_fd, peer_ip, tls_conn, now),
            poll_seq: 1,
            armed_mask: 0,
        }) else {
            close_sock(client_fd);
            continue;
        };
        let st_ref = &mut *st;
        let armed = st_ref
            .conns
            .get_mut(conn_id)
            .is_some_and(|conn| sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, true));
        if !armed {
            st_ref.remove_and_close_conn(conn_id);
        }
    }
    let _ = st.arm_listener();
}

unsafe fn drive_uring_conn(
    state_rc: &Rc<RefCell<UringState>>,
    conn_id: u32,
    revents: u32,
    now: std::time::Instant,
) {
    let mut remove = (revents & (libc::POLLERR as u32 | libc::POLLNVAL as u32)) != 0;
    let mut read_ended = false;
    let mut direct_len = 0usize;
    let mut has_buf_plaintext = false;
    let mut scratch;
    let mut fire_writable = false;
    let mut dispatch_state: Option<(
        Option<Box<dyn UvCallbacks>>,
        Vec<u8>,
        Vec<u8>,
        Vec<MaybeUninit<u8>>,
    )> = None;

    {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        scratch = std::mem::take(&mut st.read_scratch);
        ensure_read_scratch(&mut scratch);

        let want_read = (revents & (libc::POLLIN as u32 | libc::POLLHUP as u32)) != 0;
        if !remove && want_read {
            if let Some(conn) = st.conns.get_mut(conn_id) {
                if conn.core.tls.is_none() && conn.core.read_buf.is_empty() {
                    loop {
                        let n = recv_nonblock(conn.core.fd, scratch.as_mut_ptr(), scratch.len());
                        if n > 0 {
                            let n = n as usize;
                            conn.core.last_activity = now;
                            if n < scratch.len() {
                                direct_len = n;
                                conn.core.dispatching = true;
                            } else {
                                let filled =
                                    std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), n);
                                conn.core.read_buf.extend_from_slice(filled);
                                has_buf_plaintext = true;
                                let mut read_total = n;
                                while read_total < MAX_READ_PER_EVENT {
                                    let m = recv_nonblock(
                                        conn.core.fd,
                                        scratch.as_mut_ptr(),
                                        scratch.len(),
                                    );
                                    if m > 0 {
                                        let m = m as usize;
                                        read_total += m;
                                        let chunk = std::slice::from_raw_parts(
                                            scratch.as_ptr().cast::<u8>(),
                                            m,
                                        );
                                        conn.core.read_buf.extend_from_slice(chunk);
                                        if m < scratch.len() {
                                            break;
                                        }
                                    } else if m == 0 {
                                        read_ended = true;
                                        break;
                                    } else {
                                        match last_recv_error() {
                                            RecvErrKind::WouldBlock => break,
                                            RecvErrKind::Interrupted => continue,
                                            RecvErrKind::Fatal => {
                                                remove = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            break;
                        } else if n == 0 {
                            read_ended = true;
                            break;
                        } else {
                            match last_recv_error() {
                                RecvErrKind::WouldBlock => break,
                                RecvErrKind::Interrupted => continue,
                                RecvErrKind::Fatal => {
                                    remove = true;
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    let before_len = conn.core.read_buf.len();
                    let mut read_total = 0usize;
                    while read_total < MAX_READ_PER_EVENT {
                        let n = recv_nonblock(conn.core.fd, scratch.as_mut_ptr(), scratch.len());
                        if n > 0 {
                            let n = n as usize;
                            read_total += n;
                            conn.core.last_activity = now;
                            let chunk =
                                std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), n);
                            if let Some(ref mut tls_conn) = conn.core.tls {
                                match feed_ciphertext(
                                    tls_conn,
                                    chunk,
                                    &mut conn.core.read_buf,
                                    &mut conn.core.write_buf,
                                ) {
                                    Ok(true) => {
                                        read_ended = true;
                                        break;
                                    }
                                    Ok(false) => {}
                                    Err(_) => {
                                        conn.core.close_after_write = true;
                                        break;
                                    }
                                }
                            } else {
                                conn.core.read_buf.extend_from_slice(chunk);
                            }
                            if n < scratch.len() {
                                break;
                            }
                        } else if n == 0 {
                            read_ended = true;
                            break;
                        } else {
                            match last_recv_error() {
                                RecvErrKind::WouldBlock => break,
                                RecvErrKind::Interrupted => continue,
                                RecvErrKind::Fatal => {
                                    remove = true;
                                    break;
                                }
                            }
                        }
                    }
                    has_buf_plaintext = conn.core.read_buf.len() > before_len;
                }
                if read_ended {
                    conn.core.read_ended = true;
                    conn.core.eof_at.get_or_insert(now);
                }
            }
        }
        if read_ended {
            st.read_ended.push(conn_id);
            st.turn_dirty = true;
        }

        if !remove && (direct_len > 0 || has_buf_plaintext) {
            if let Some(c) = st.conns.get_mut(conn_id) {
                c.core.dispatching = true;
                let taken = if direct_len > 0 {
                    Vec::new()
                } else {
                    std::mem::take(&mut c.core.read_buf)
                };
                let mut sw = std::mem::take(&mut st.scratch_write);
                sw.clear();
                let cb = st.callbacks.take();
                st.dispatching = Some(conn_id);
                let s = std::mem::take(&mut scratch);
                dispatch_state = Some((cb, taken, sw, s));
            }
        } else if !remove {
            let st_ref = &mut *st;
            if let Some(conn) = st_ref.conns.get_mut(conn_id) {
                if conn.core.close_after_write
                    || conn.core.write_pos < conn.core.write_buf.len()
                    || (revents & libc::POLLOUT as u32) != 0
                {
                    let fa = flush_write_buf_core(&mut conn.core);
                    if fa == FlushAction::Close {
                        remove = true;
                    } else {
                        if fa == FlushAction::DisarmWritable {
                            fire_writable = true;
                        }
                        sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, true);
                    }
                } else {
                    sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, true);
                }
            }
        }

        if dispatch_state.is_none() {
            if remove {
                st.remove_and_close_conn(conn_id);
            }
            if st.read_scratch.is_empty() {
                st.read_scratch = scratch;
            }
        }
    }

    if let Some((mut cb, mut read_buf, mut cleartext_write, scratch)) = dispatch_state {
        let action = if let Some(ref mut handler) = cb {
            let input_slice = if direct_len > 0 {
                std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), direct_len)
            } else {
                &read_buf
            };
            handler.on_data(conn_id, input_slice, &mut cleartext_write)
        } else {
            ConnAction::CloseNow
        };

        let mut st = state_rc.borrow_mut();
        st.dispatching = None;
        let mut deferred = std::mem::take(&mut st.deferred);
        let deferred_close = std::mem::take(&mut st.deferred_close);
        let deferred_bp = std::mem::take(&mut st.deferred_bp);
        if st.closed {
            return;
        }
        cleartext_write.extend_from_slice(&deferred);
        deferred.clear();
        st.deferred = deferred;
        let action = match action {
            ConnAction::Continue { consumed } if deferred_close => {
                ConnAction::CloseAfterWrite { consumed }
            }
            other => other,
        };
        st.callbacks = cb;
        st.turn_dirty = true;
        let max_write = write_buf_limit(st.cfg);
        let st_ref = &mut *st;
        if let Some(conn) = st_ref.conns.get_mut(conn_id) {
            conn.core.dispatching = false;
            conn.core.linger |= matches!(action, ConnAction::Refuse { .. });
            if direct_len > 0 {
                let mut progressed = false;
                let leftover_start = match action {
                    ConnAction::Continue { consumed } => {
                        progressed = consumed > 0;
                        consumed.min(direct_len)
                    }
                    ConnAction::CloseAfterWrite { consumed } | ConnAction::Refuse { consumed } => {
                        conn.core.close_after_write = true;
                        progressed = consumed > 0;
                        consumed.min(direct_len)
                    }
                    ConnAction::CloseNow => {
                        remove = true;
                        direct_len
                    }
                };
                if !remove && leftover_start < direct_len {
                    let slice =
                        std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), direct_len);
                    conn.core
                        .read_buf
                        .extend_from_slice(&slice[leftover_start..]);
                    if progressed || conn.core.partial_since.is_none() {
                        conn.core.partial_since = Some(now);
                    }
                } else {
                    conn.core.partial_since = None;
                }
            } else {
                let mut progressed = false;
                match action {
                    ConnAction::Continue { consumed } => {
                        if consumed > 0 {
                            read_buf.drain(..consumed);
                            progressed = true;
                        }
                    }
                    ConnAction::CloseAfterWrite { consumed } | ConnAction::Refuse { consumed } => {
                        if consumed > 0 {
                            read_buf.drain(..consumed);
                            progressed = true;
                        }
                        conn.core.close_after_write = true;
                    }
                    ConnAction::CloseNow => {
                        remove = true;
                    }
                }
                if read_buf.is_empty() && read_buf.capacity() > SHRINK_THRESHOLD {
                    read_buf.shrink_to(READ_SCRATCH_SIZE);
                }
                if read_buf.is_empty() {
                    conn.core.partial_since = None;
                } else if progressed || conn.core.partial_since.is_none() {
                    conn.core.partial_since = Some(now);
                }
                conn.core.read_buf = read_buf;
            }
            if !remove && !cleartext_write.is_empty() {
                let fa = write_bytes_or_queue(&mut conn.core, &cleartext_write, max_write);
                if fa == FlushAction::Close || conn.core.queued_bytes() > max_write {
                    remove = true;
                } else if fa == FlushAction::DisarmWritable {
                    fire_writable = true;
                }
            }
            if !remove
                && (conn.core.close_after_write
                    || conn.core.write_pos < conn.core.write_buf.len()
                    || (revents & libc::POLLOUT as u32) != 0)
            {
                let fa = flush_write_buf_core(&mut conn.core);
                if fa == FlushAction::Close {
                    remove = true;
                } else if fa == FlushAction::DisarmWritable {
                    fire_writable = true;
                }
            }
            if !remove && deferred_bp && !conn.core.writable_armed {
                fire_writable = true;
            }
            if !remove && !sync_conn_poll(st_ref.ring.as_mut(), conn, conn_id, true) {
                remove = true;
            }
        }
        cleartext_write.clear();
        if cleartext_write.capacity() > SHRINK_THRESHOLD {
            cleartext_write.shrink_to(READ_SCRATCH_SIZE);
        }
        st.scratch_write = cleartext_write;
        st.read_scratch = scratch;
        if remove {
            st.remove_and_close_conn(conn_id);
        }
    }

    if fire_writable {
        let cb = state_rc.borrow_mut().callbacks.take();
        if let Some(mut handler) = cb {
            handler.on_writable(conn_id);
            let mut st = state_rc.borrow_mut();
            if !st.closed {
                st.callbacks = Some(handler);
            }
        }
    }
}

unsafe extern "C" fn on_uring_event(handle: *mut c_void, status: c_int, _events: c_int) {
    if status < 0 {
        return;
    }
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const UringCtx);
    let state_rc = Rc::clone(&ctx.state);
    let evfd = ctx.evfd;

    let mut counter: u64 = 0;
    loop {
        let n = libc::read(evfd, (&mut counter as *mut u64).cast(), 8);
        if n <= 0 {
            break;
        }
    }

    let now = {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        st.in_poll_loop = true;
        let uv_ms = (uv.now)(st.uv_loop);
        let now = st.clock.tick(uv_ms);
        let mut cqe_scratch = std::mem::take(&mut st.cqe_scratch);
        cqe_scratch.clear();
        if let Some(ref mut ring) = st.ring {
            let _ = ring.submit();
            let cq = ring.completion();
            for entry in cq {
                cqe_scratch.push((entry.user_data(), entry.result()));
            }
        }
        st.cqe_scratch = cqe_scratch;
        now
    };

    let count = state_rc.borrow().cqe_scratch.len();
    for idx in 0..count {
        let (ud, res) = state_rc.borrow().cqe_scratch[idx];
        if ud == CANCEL_EVENT_ID {
            continue;
        }
        if ud == LISTENER_CANCEL_EVENT_ID {
            if res < 0 {
                state_rc.borrow_mut().listener_cancel = ListenerCancel::Unqueued;
            }
            continue;
        }
        if ud == LISTENER_EVENT_ID {
            let mut st = state_rc.borrow_mut();
            st.listener_armed = false;
            if st.listener_stopping {
                st.release_listener();
            } else if res < 0 {
                let _ = st.arm_listener();
            } else {
                drop(st);
                accept_ready_uring(&state_rc, now);
            }
            continue;
        }
        let conn_id = (ud & 0xffff_ffff) as u32;
        let seq = (ud >> 32) as u32;
        let matches = state_rc
            .borrow()
            .conns
            .get(conn_id)
            .is_some_and(|c| c.poll_seq == seq);
        if !matches {
            continue;
        }
        {
            let mut st = state_rc.borrow_mut();
            if let Some(conn) = st.conns.get_mut(conn_id) {
                conn.armed_mask = 0;
            }
        }
        let revents = if res < 0 {
            libc::POLLERR as u32
        } else {
            res as u32
        };
        drive_uring_conn(&state_rc, conn_id, revents, now);
    }

    flush_turn_end(&state_rc);
    let mut st = state_rc.borrow_mut();
    st.in_poll_loop = false;
    if !st.closed {
        st.submit_ring();
    }
}

fn flush_turn_end(state_rc: &Rc<RefCell<UringState>>) {
    let (cb, disconnects, writable, turn_dirty) = {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        let turn_dirty = st.turn_dirty;
        st.turn_dirty = false;
        let disconnects = std::mem::take(&mut st.pending_disconnects);
        let writable = std::mem::take(&mut st.pending_writable);
        let cb = if turn_dirty || !disconnects.is_empty() || !writable.is_empty() {
            st.callbacks.take()
        } else {
            None
        };
        (cb, disconnects, writable, turn_dirty)
    };
    let Some(mut handler) = cb else {
        return;
    };
    for conn_id in disconnects {
        handler.on_disconnect(conn_id);
    }
    if turn_dirty {
        handler.on_turn_end();
    }
    for conn_id in writable {
        if state_rc.borrow().conns.get(conn_id).is_some() {
            handler.on_writable(conn_id);
        }
    }
    let mut st = state_rc.borrow_mut();
    if !st.closed {
        let mut i = 0;
        while i < st.read_ended.len() {
            let id = st.read_ended[i];
            if !handler.has_pending_requests(id) {
                st.read_ended.swap_remove(i);
                let st_ref = &mut *st;
                if let Some(conn) = st_ref.conns.get_mut(id) {
                    conn.core.close_after_write = true;
                    let fa = flush_write_buf_core(&mut conn.core);
                    if fa == FlushAction::Close {
                        st_ref.remove_and_close_conn(id);
                    } else if fa != FlushAction::None
                        && !sync_conn_poll(st_ref.ring.as_mut(), conn, id, false)
                    {
                        st_ref.remove_and_close_conn(id);
                    }
                }
            } else {
                i += 1;
            }
        }
        if !st.pending_disconnects.is_empty() {
            st.arm_check();
        }
        st.callbacks = Some(handler);
        st.submit_ring();
    }
}

unsafe extern "C" fn on_check_event(handle: *mut c_void) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const CheckCtx);
    let state_rc = Rc::clone(&ctx.state);
    {
        let mut st = state_rc.borrow_mut();
        st.check_armed = false;
        if !st.closed {
            let _ = (uv.check_stop)(handle);
        }
    }
    flush_turn_end(&state_rc);
}

unsafe extern "C" fn on_timer_event(handle: *mut c_void) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const TimerCtx);
    let state_rc = Rc::clone(&ctx.state);

    let (close, replies, cb) = {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        if st.listener_stopping && st.listener_armed {
            st.cancel_listener_poll();
        }
        let uv_ms = (uv.now)(st.uv_loop);
        if !st.clock.on_timer_tick(uv_ms) {
            return;
        }
        let now = st.clock.now();
        let sweep = {
            let st = &mut *st;
            collect_timeouts(
                st.conns.iter().map(|(id, c)| (id, &c.core)),
                now,
                st.cfg,
                st.callbacks.as_deref_mut(),
            )
        };
        let max_write = write_buf_limit(st.cfg);
        let mut close = sweep.close;
        for id in sweep.ping {
            let st_ref = &mut *st;
            if let Some(conn) = st_ref.conns.get_mut(id) {
                conn.core.last_activity = now;
                let fa = write_bytes_or_queue(&mut conn.core, &WS_PING_FRAME, max_write);
                if fa == FlushAction::Close {
                    close.push(id);
                } else if fa != FlushAction::None
                    && !sync_conn_poll(st_ref.ring.as_mut(), conn, id, false)
                {
                    close.push(id);
                }
            }
        }
        for &id in &close {
            st.remove_and_close_conn(id);
        }
        st.submit_ring();
        (close, sweep.replies, st.callbacks.take())
    };
    let _ = close;
    if let Some(mut handler) = cb {
        handler.flush_aborted();
        let mut st = state_rc.borrow_mut();
        if !st.closed {
            st.callbacks = Some(handler);
        }
    }
    let srv = UringServer {
        state: Rc::clone(&state_rc),
    };
    for (id, reply) in replies {
        srv.write_to_conn(id, &reply, false, false);
    }
    flush_turn_end(&state_rc);
}

unsafe extern "C" fn on_owned_fd_poll_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            drop(Box::from_raw(data as *mut OwnedFd));
        }
        free_handle(handle, uv.poll_size);
    }
}

unsafe extern "C" fn on_uring_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut UringCtx);
            if ctx.evfd >= 0 {
                libc::close(ctx.evfd);
            }
            drop(ctx);
        }
        free_handle(handle, uv.poll_size);
    }
}

unsafe extern "C" fn on_check_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut CheckCtx);
            drop(ctx);
        }
        free_handle(handle, uv.check_size);
    }
}

unsafe extern "C" fn on_timer_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut TimerCtx);
            drop(ctx);
        }
        free_handle(handle, uv.timer_size);
    }
}
