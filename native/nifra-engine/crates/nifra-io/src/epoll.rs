//! Linux dedicated `epoll` driver multiplexed inside Node.js's `uv_loop_t` via a single
//! `uv_poll_t` watcher on the `epoll` file descriptor.
//!
//! Compared to one `uv_poll_t` per socket + `uv_check_t`, this eliminates libuv watcher churn,
//! uses `accept4(SOCK_NONBLOCK | SOCK_CLOEXEC)` and `send(..., MSG_DONTWAIT | MSG_NOSIGNAL)`,
//! runs `on_turn_end()` synchronously inside the poll callback with zero `uv_check` round-trips,
//! and keeps socket structures hot in L1/L2 cache.

#![cfg(target_os = "linux")]

use std::cell::RefCell;
use std::ffi::{c_int, c_void};
use std::io;
use std::mem::MaybeUninit;
use std::net::TcpListener as StdTcpListener;
use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd, RawFd};
use std::rc::Rc;
use std::sync::Arc;

use nifra_tls::{feed_ciphertext, TlsError, TlsInput, TlsStore};

use crate::sys::{
    alloc_handle, alloc_read_scratch, collect_timeouts, ensure_read_scratch, flush_write_buf_core,
    free_handle, open_spare_fd, peer_ip_from_storage, recv_nonblock, set_tcp_nodelay,
    socket_incoming_cpu, uv_api, write_buf_limit, write_bytes_or_queue, ConnCore, ConnSlab,
    FlushAction, LoopClock, UvApi, DATE_TICK_INTERVAL_MS, MAX_READ_PER_EVENT, MAX_WRITE_BUF_BYTES,
    READ_SCRATCH_SIZE, SHRINK_THRESHOLD, UV_READABLE, WS_PING_FRAME,
};
use crate::uv::{UvCallbacks, WriteResult};
use crate::{ConnAction, SocketConfig};

const LISTENER_EVENT_ID: u64 = 0;
const MAX_EPOLL_EVENTS: usize = 512;
const DEFAULT_FLUSH_CHUNK: usize = 16;
const DEFAULT_DRAIN_ROUNDS: usize = 4;
const DEFAULT_CPU_FLUSH_MIN: usize = 1;
const MAX_INCOMING_CPUS: u32 = 4096;

#[derive(Clone, Copy)]
struct ReadyEvent {
    sort_key: u64,
    cpu_group: i32,
    events: u32,
    conn_id: u32,
}

fn epoll_tuning() -> (usize, usize, bool, usize) {
    let chunk = std::env::var("NIFRA_EPOLL_CHUNK")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_FLUSH_CHUNK);
    let rounds = std::env::var("NIFRA_EPOLL_ROUNDS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_DRAIN_ROUNDS);
    let cpu_order = std::env::var("NIFRA_EPOLL_CPU_ORDER").ok().as_deref() != Some("0");
    let cpu_flush_min = std::env::var("NIFRA_EPOLL_CPU_FLUSH")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_CPU_FLUSH_MIN);
    (chunk, rounds, cpu_order, cpu_flush_min)
}

#[inline]
unsafe fn epoll_ctl_mod(epfd: RawFd, fd: RawFd, conn_id: u32, events: u32) -> bool {
    let mut ev = libc::epoll_event {
        events,
        u64: u64::from(conn_id),
    };
    // A connection whose read side ended and queue drained was taken out of the set: re-add it.
    if libc::epoll_ctl(epfd, libc::EPOLL_CTL_MOD, fd, &mut ev) == 0 {
        return true;
    }
    *libc::__errno_location() == libc::ENOENT
        && libc::epoll_ctl(epfd, libc::EPOLL_CTL_ADD, fd, &mut ev) == 0
}

#[inline]
unsafe fn epoll_ctl_del_and_close(epfd: RawFd, fd: RawFd) {
    if epfd >= 0 {
        libc::epoll_ctl(epfd, libc::EPOLL_CTL_DEL, fd, std::ptr::null_mut());
    }
    libc::close(fd);
}

#[inline]
fn apply_epoll_flush_action(epfd: RawFd, core: &mut ConnCore, conn_id: u32, action: FlushAction) {
    unsafe {
        match action {
            FlushAction::ArmWritable => {
                let events = (libc::EPOLLOUT as u32)
                    | if core.read_ended || core.is_read_paused() {
                        0
                    } else {
                        libc::EPOLLIN as u32
                    };
                if !epoll_ctl_mod(epfd, core.fd, conn_id, events) {
                    // No event will ever drain it: the timeout sweep closes it.
                    core.close_deadline = Some(std::time::Instant::now());
                }
            }
            FlushAction::DisarmWritable => {
                if core.read_ended || core.is_read_paused() {
                    libc::epoll_ctl(epfd, libc::EPOLL_CTL_DEL, core.fd, std::ptr::null_mut());
                } else {
                    epoll_ctl_mod(epfd, core.fd, conn_id, libc::EPOLLIN as u32);
                }
            }
            FlushAction::None | FlushAction::Close => {}
        }
    }
}

struct EpollCtx {
    state: Rc<RefCell<EpollState>>,
    epfd: RawFd,
}

struct CheckCtx {
    state: Rc<RefCell<EpollState>>,
}

struct TimerCtx {
    state: Rc<RefCell<EpollState>>,
}

struct EpollState {
    uv: &'static UvApi,
    uv_loop: *mut c_void,
    is_tcp: bool,
    cfg: SocketConfig,
    tls: Option<Arc<TlsStore>>,
    clock: LoopClock,
    epfd: RawFd,
    listener_fd: RawFd,
    unix_guard: Option<crate::UnixSocketGuard>,
    epoll_handle: *mut c_void,
    check_handle: *mut c_void,
    check_armed: bool,
    timer_handle: *mut c_void,
    conns: ConnSlab<ConnCore>,
    read_ended: Vec<u32>,
    pending_disconnects: Vec<u32>,
    pending_writable: Vec<u32>,
    turn_dirty: bool,
    in_poll_loop: bool,
    closed: bool,
    listener_tcp_nodelay_inherited: bool,
    read_scratch: Vec<MaybeUninit<u8>>,
    scratch_write: Vec<u8>,
    events_scratch: Vec<libc::epoll_event>,
    ready_scratch: Vec<ReadyEvent>,
    spare_fd: RawFd,
    dispatching: Option<u32>,
    deferred: Vec<u8>,
    deferred_close: bool,
    deferred_bp: bool,
    flush_chunk: usize,
    max_drain_rounds: usize,
    cpu_order: bool,
    cpu_flush_min: usize,
    cpu_round: u32,
    max_incoming_cpus: u32,
    callbacks: Option<Box<dyn UvCallbacks>>,
}

impl EpollState {
    fn queue_disconnect(&mut self, conn_id: u32) {
        self.pending_disconnects.push(conn_id);
        if !self.in_poll_loop {
            self.arm_check();
        }
    }

    fn arm_check(&mut self) {
        if !self.check_armed && !self.closed && !self.check_handle.is_null() {
            unsafe {
                if (self.uv.check_start)(self.check_handle, on_epoll_check) == 0 {
                    self.check_armed = true;
                }
            }
        }
    }

    fn disarm_check_if_idle(&mut self) {
        if self.check_armed
            && !self.turn_dirty
            && self.pending_disconnects.is_empty()
            && self.pending_writable.is_empty()
            && !self.check_handle.is_null()
        {
            unsafe {
                (self.uv.check_stop)(self.check_handle);
            }
            self.check_armed = false;
        }
    }

    fn remove_and_close_conn(&mut self, conn_id: u32) -> bool {
        let Some(conn) = self.conns.remove(conn_id) else {
            return false;
        };
        unsafe { epoll_ctl_del_and_close(self.epfd, conn.fd) };
        if conn.read_ended {
            if let Some(pos) = self.read_ended.iter().position(|&id| id == conn_id) {
                self.read_ended.swap_remove(pos);
            }
        }
        self.queue_disconnect(conn_id);
        true
    }
}

/// Linux `epoll`-backed server handle matching `UvServer` method signatures.
#[derive(Clone)]
pub struct EpollServer {
    state: Rc<RefCell<EpollState>>,
}

impl EpollServer {
    /// # Safety
    /// `uv_loop` must point to the live `uv_loop_t` of the calling thread and outlive the server.
    pub unsafe fn start_with_tls(
        uv_loop: *mut c_void,
        listener: StdTcpListener,
        cfg: SocketConfig,
        tls: Option<Arc<TlsStore>>,
        callbacks: Box<dyn UvCallbacks>,
    ) -> io::Result<Self> {
        // `accept4(SOCK_NONBLOCK)` only makes accepted sockets nonblocking: a blocking listener
        // would stall Node's thread once the backlog is empty.
        listener.set_nonblocking(true)?;
        Self::start_fd_with_tls(
            uv_loop,
            OwnedFd::from(listener),
            true,
            None,
            cfg,
            tls,
            callbacks,
        )
    }

    /// # Safety
    /// `uv_loop` must point to the live `uv_loop_t` of the calling thread and outlive the server.
    pub(crate) unsafe fn start_fd_with_tls(
        uv_loop: *mut c_void,
        listener: OwnedFd,
        is_tcp: bool,
        unix_guard: Option<crate::UnixSocketGuard>,
        cfg: SocketConfig,
        tls: Option<Arc<TlsStore>>,
        callbacks: Box<dyn UvCallbacks>,
    ) -> io::Result<Self> {
        if uv_loop.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "null uv_loop_t pointer",
            ));
        }
        let uv = uv_api()?;
        let epfd = libc::epoll_create1(libc::EPOLL_CLOEXEC);
        if epfd < 0 {
            return Err(io::Error::last_os_error());
        }

        let listener_fd = listener.as_raw_fd();
        let nodelay_inherited = if is_tcp && cfg.tcp_nodelay {
            set_tcp_nodelay(listener_fd)
        } else {
            true
        };

        let mut lev = libc::epoll_event {
            events: libc::EPOLLIN as u32,
            u64: LISTENER_EVENT_ID,
        };
        if libc::epoll_ctl(epfd, libc::EPOLL_CTL_ADD, listener_fd, &mut lev) != 0 {
            let err = io::Error::last_os_error();
            libc::close(epfd);
            return Err(err);
        }

        let epoll_handle = alloc_handle(uv.poll_size);
        let rc = (uv.poll_init)(uv_loop, epoll_handle, epfd);
        if rc != 0 {
            free_handle(epoll_handle, uv.poll_size);
            libc::close(epfd);
            return Err(io::Error::other(format!("uv_poll_init(epfd) failed: {rc}")));
        }

        let check_handle = alloc_handle(uv.check_size);
        let rc = (uv.check_init)(uv_loop, check_handle);
        if rc != 0 {
            free_handle(check_handle, uv.check_size);
            (uv.close)(epoll_handle, on_raw_epoll_close);
            libc::close(epfd);
            return Err(io::Error::other(format!("uv_check_init failed: {rc}")));
        }

        let initial_uv_ms = (uv.now)(uv_loop);
        let (flush_chunk, max_drain_rounds, cpu_order, cpu_flush_min) = epoll_tuning();
        let owned_listener_fd = listener.into_raw_fd();

        let state = Rc::new(RefCell::new(EpollState {
            uv,
            uv_loop,
            is_tcp,
            cfg,
            tls,
            clock: LoopClock::new(initial_uv_ms),
            epfd,
            listener_fd: owned_listener_fd,
            unix_guard,
            epoll_handle,
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
            listener_tcp_nodelay_inherited: nodelay_inherited,
            read_scratch: alloc_read_scratch(),
            scratch_write: Vec::with_capacity(16 * 1024),
            events_scratch: vec![libc::epoll_event { events: 0, u64: 0 }; MAX_EPOLL_EVENTS],
            ready_scratch: Vec::with_capacity(MAX_EPOLL_EVENTS),
            spare_fd: open_spare_fd(),
            dispatching: None,
            deferred: Vec::new(),
            deferred_close: false,
            deferred_bp: false,
            flush_chunk,
            max_drain_rounds,
            cpu_order,
            cpu_flush_min,
            cpu_round: 0,
            max_incoming_cpus: 1,
            callbacks: Some(callbacks),
        }));

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

        let e_ctx = Box::into_raw(Box::new(EpollCtx {
            state: Rc::clone(&state),
            epfd,
        }));
        (uv.handle_set_data)(epoll_handle, e_ctx.cast());

        let c_ctx = Box::into_raw(Box::new(CheckCtx {
            state: Rc::clone(&state),
        }));
        (uv.handle_set_data)(check_handle, c_ctx.cast());

        let rc = (uv.poll_start)(epoll_handle, UV_READABLE, on_epoll_event);
        if rc != 0 {
            let srv = Self { state };
            srv.close_all();
            return Err(io::Error::other(format!(
                "uv_poll_start(epfd) failed: {rc}"
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
            .map(|c| c.peer_ip.map_or_else(String::new, |ip| ip.to_string()))
    }

    pub fn has_read_ended(&self, conn_id: u32) -> bool {
        self.state
            .borrow()
            .conns
            .get(conn_id)
            .is_some_and(|conn| conn.read_ended && !conn.dispatching)
    }

    pub fn alpn_protocol(&self, conn_id: u32) -> Option<Vec<u8>> {
        self.state
            .borrow()
            .conns
            .get(conn_id)
            .and_then(|c| c.alpn_protocol())
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
                let effective_close =
                    close_after || (close_if_read_ended && conn.read_ended && !conn.dispatching);
                let next_len = st.deferred.len().saturating_add(bytes.len());
                if next_len > max_write.max(MAX_WRITE_BUF_BYTES) {
                    st.remove_and_close_conn(conn_id);
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
        let epfd = st.epfd;
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return WriteResult::Closed;
        };
        conn.last_activity = now;
        let read_ended = conn.read_ended;
        let effective_close =
            close_after || (close_if_read_ended && read_ended && !conn.dispatching);
        if conn.queued_bytes() >= max_write && (conn.cork_depth == 0 || conn.writable_armed) {
            st.remove_and_close_conn(conn_id);
            return WriteResult::Closed;
        }
        if effective_close {
            conn.close_after_write = true;
        }
        let fa = write_bytes_or_queue(conn, bytes, max_write);
        if fa == FlushAction::Close || conn.queued_bytes() > max_write {
            st.remove_and_close_conn(conn_id);
            return WriteResult::Closed;
        }
        let armed = conn.writable_armed;
        apply_epoll_flush_action(epfd, conn, conn_id, fa);
        if fa == FlushAction::DisarmWritable {
            // A producer waiting for the queue to drain is woken at the turn's end.
            st.pending_writable.push(conn_id);
            if !st.in_poll_loop {
                st.arm_check();
            }
        }
        if read_ended {
            st.turn_dirty = true;
            if !st.in_poll_loop {
                st.arm_check();
            }
        }
        if armed {
            WriteResult::Backpressured
        } else {
            WriteResult::Written
        }
    }

    pub fn close_conn(&self, conn_id: u32) -> bool {
        self.state.borrow_mut().remove_and_close_conn(conn_id)
    }

    pub fn cork_begin(&self, conn_id: u32) -> bool {
        let mut st = self.state.borrow_mut();
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return false;
        };
        conn.cork_depth = conn.cork_depth.saturating_add(1);
        true
    }

    pub fn cork_end(&self, conn_id: u32) -> WriteResult {
        let mut st = self.state.borrow_mut();
        let epfd = st.epfd;
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return WriteResult::Closed;
        };
        conn.cork_depth = conn.cork_depth.saturating_sub(1);
        if conn.cork_depth > 0 {
            return if conn.writable_armed {
                WriteResult::Backpressured
            } else {
                WriteResult::Written
            };
        }
        if conn.queued_bytes() == 0 && !conn.close_after_write {
            return if conn.writable_armed {
                WriteResult::Backpressured
            } else {
                WriteResult::Written
            };
        }
        let fa = flush_write_buf_core(conn);
        if fa == FlushAction::Close {
            st.remove_and_close_conn(conn_id);
            return WriteResult::Closed;
        }
        let armed = conn.writable_armed;
        apply_epoll_flush_action(epfd, conn, conn_id, fa);
        if fa == FlushAction::DisarmWritable {
            st.pending_writable.push(conn_id);
            if !st.in_poll_loop {
                st.arm_check();
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
            conn.close_deadline = Some(at);
        }
    }

    pub fn any_queued(&self) -> bool {
        let st = self.state.borrow();
        // `deferred` holds what a handler wrote during its own dispatch, not yet on any queue.
        !st.deferred.is_empty() || st.conns.iter().any(|(_, c)| c.queued_bytes() > 0)
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
            c.queued_output(deferred, st.deferred_bp, include_corked)
        })
    }

    pub fn set_read_paused(&self, conn_id: u32, paused: bool) -> bool {
        let mut st = self.state.borrow_mut();
        let epfd = st.epfd;
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return false;
        };
        if conn.app_read_paused == paused {
            return true;
        }
        let events = (if conn.writable_armed {
            libc::EPOLLOUT as u32
        } else {
            0
        }) | (if conn.read_ended || conn.is_read_paused() {
            0
        } else {
            libc::EPOLLIN as u32
        });
        let applied = unsafe {
            if events == 0 {
                if epfd >= 0 {
                    libc::epoll_ctl(epfd, libc::EPOLL_CTL_DEL, conn.fd, std::ptr::null_mut());
                    true
                } else {
                    false
                }
            } else {
                epoll_ctl_mod(epfd, conn.fd, conn_id, events)
            }
        };
        if !applied {
            return false;
        }
        conn.app_read_paused = paused;
        true
    }

    pub fn stop_listening(&self) {
        let mut st = self.state.borrow_mut();
        if st.listener_fd >= 0 {
            let lfd = st.listener_fd;
            st.listener_fd = -1;
            unsafe { epoll_ctl_del_and_close(st.epfd, lfd) };
        }
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
        let epfd = st.epfd;
        let drained = st.conns.drain();
        for c in drained {
            unsafe { epoll_ctl_del_and_close(epfd, c.fd) };
        }
        st.read_ended.clear();
        st.pending_disconnects.clear();
        st.pending_writable.clear();
        st.epfd = -1;

        if !st.epoll_handle.is_null() {
            let h = st.epoll_handle;
            st.epoll_handle = std::ptr::null_mut();
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    (uv.poll_stop)(h);
                    (uv.close)(h, on_epoll_handle_close);
                }
            }
        } else if epfd >= 0 {
            unsafe { libc::close(epfd) };
        }

        if !st.check_handle.is_null() {
            let h = st.check_handle;
            st.check_handle = std::ptr::null_mut();
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    if st.check_armed {
                        (uv.check_stop)(h);
                    }
                    (uv.close)(h, on_check_close);
                }
            }
        }
        st.check_armed = false;

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
        if st.spare_fd >= 0 {
            unsafe { libc::close(st.spare_fd) };
            st.spare_fd = -1;
        }
    }
}

unsafe fn accept_pending(st: &mut EpollState, now: std::time::Instant) {
    let lfd = st.listener_fd;
    if lfd < 0 || st.epfd < 0 {
        return;
    }
    let nodelay = st.is_tcp && st.cfg.tcp_nodelay && !st.listener_tcp_nodelay_inherited;

    loop {
        let mut storage: libc::sockaddr_storage = std::mem::zeroed();
        let mut addr_len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        let client_fd = libc::accept4(
            lfd,
            (&mut storage as *mut libc::sockaddr_storage).cast(),
            &mut addr_len,
            libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
        );
        if client_fd < 0 {
            let err = io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::EMFILE | libc::ENFILE) if st.spare_fd >= 0 => {
                    libc::close(st.spare_fd);
                    let shed = libc::accept4(
                        lfd,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                    );
                    if shed >= 0 {
                        libc::close(shed);
                    }
                    st.spare_fd = open_spare_fd();
                    continue;
                }
                Some(libc::ECONNABORTED | libc::EPROTO | libc::EINTR) => continue,
                _ => break,
            }
        }
        if st.cfg.max_connections > 0 && st.conns.len() >= st.cfg.max_connections {
            libc::close(client_fd);
            continue;
        }

        let tls_conn = match &st.tls {
            Some(store) => match store.new_connection() {
                Ok(c) => Some(c),
                Err(_) => {
                    libc::close(client_fd);
                    continue;
                }
            },
            None => None,
        };
        let incoming_cpu = socket_incoming_cpu(client_fd);
        if incoming_cpu >= 0 {
            let cpus = (incoming_cpu as u32)
                .saturating_add(1)
                .min(MAX_INCOMING_CPUS);
            if cpus > st.max_incoming_cpus {
                st.max_incoming_cpus = cpus;
            }
        }
        let peer_ip = peer_ip_from_storage(&storage);
        if nodelay {
            set_tcp_nodelay(client_fd);
        }

        let Some(conn_id) = st.conns.alloc_with(|_| {
            let mut core = ConnCore::new(client_fd, peer_ip, tls_conn, now);
            core.incoming_cpu = incoming_cpu;
            core
        }) else {
            libc::close(client_fd);
            continue;
        };

        let mut ev = libc::epoll_event {
            events: libc::EPOLLIN as u32,
            u64: u64::from(conn_id),
        };
        if libc::epoll_ctl(st.epfd, libc::EPOLL_CTL_ADD, client_fd, &mut ev) != 0 {
            st.conns.remove(conn_id);
            libc::close(client_fd);
        }
    }
}

unsafe fn handle_client_readable(
    state_rc: &Rc<RefCell<EpollState>>,
    conn_id: u32,
    events: u32,
    now: std::time::Instant,
) -> bool {
    let mut remove = false;
    let mut read_ended = false;
    let mut direct_len = 0usize;
    let mut has_buf_plaintext = false;
    let mut scratch;
    let mut negotiated_h2 = false;
    let mut dispatch_state: Option<(Option<Box<dyn UvCallbacks>>, Vec<u8>, Vec<u8>)> = None;

    {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return false;
        }
        scratch = std::mem::take(&mut st.read_scratch);
        ensure_read_scratch(&mut scratch);

        let epfd = st.epfd;
        let mut max_cpus = st.max_incoming_cpus;
        if let Some(conn) = st.conns.get_mut(conn_id) {
            if conn.tls.is_none() && conn.read_buf.is_empty() {
                loop {
                    let n = recv_nonblock(conn.fd, scratch.as_mut_ptr(), scratch.len());
                    if n > 0 {
                        let n = n as usize;
                        conn.last_activity = now;
                        conn.recv_count = conn.recv_count.wrapping_add(1);
                        if conn.incoming_cpu < 0 || (conn.recv_count & 0x3ff) == 0 {
                            let cpu = socket_incoming_cpu(conn.fd);
                            if cpu >= 0 {
                                conn.incoming_cpu = cpu;
                                max_cpus = max_cpus
                                    .max((cpu as u32).saturating_add(1).min(MAX_INCOMING_CPUS));
                            }
                        }
                        if n < scratch.len() {
                            direct_len = n;
                            conn.dispatching = true;
                        } else {
                            let filled =
                                std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), n);
                            conn.read_buf.extend_from_slice(filled);
                            has_buf_plaintext = true;
                            let mut read_total = n;
                            while read_total < MAX_READ_PER_EVENT {
                                let m = recv_nonblock(conn.fd, scratch.as_mut_ptr(), scratch.len());
                                if m > 0 {
                                    let m = m as usize;
                                    read_total += m;
                                    let chunk = std::slice::from_raw_parts(
                                        scratch.as_ptr().cast::<u8>(),
                                        m,
                                    );
                                    conn.read_buf.extend_from_slice(chunk);
                                    if m < scratch.len() {
                                        break;
                                    }
                                } else if m == 0 {
                                    read_ended = true;
                                    break;
                                } else {
                                    let err = io::Error::last_os_error();
                                    if err.kind() == io::ErrorKind::WouldBlock {
                                        break;
                                    }
                                    if err.kind() == io::ErrorKind::Interrupted {
                                        continue;
                                    }
                                    remove = true;
                                    break;
                                }
                            }
                        }
                        break;
                    } else if n == 0 {
                        read_ended = true;
                        break;
                    } else {
                        let err = io::Error::last_os_error();
                        if err.kind() == io::ErrorKind::WouldBlock {
                            break;
                        }
                        if err.kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        remove = true;
                        break;
                    }
                }
            } else {
                let before_len = conn.read_buf.len();
                let mut read_total = 0usize;
                while read_total < MAX_READ_PER_EVENT {
                    let n = recv_nonblock(conn.fd, scratch.as_mut_ptr(), scratch.len());
                    if n > 0 {
                        let n = n as usize;
                        read_total += n;
                        conn.last_activity = now;
                        conn.recv_count = conn.recv_count.wrapping_add(1);
                        if conn.incoming_cpu < 0 || (conn.recv_count & 0x3ff) == 0 {
                            let cpu = socket_incoming_cpu(conn.fd);
                            if cpu >= 0 {
                                conn.incoming_cpu = cpu;
                                max_cpus = max_cpus
                                    .max((cpu as u32).saturating_add(1).min(MAX_INCOMING_CPUS));
                            }
                        }
                        let chunk = std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), n);
                        if let Some(ref mut tls_conn) = conn.tls {
                            match feed_ciphertext(
                                tls_conn,
                                chunk,
                                &mut conn.read_buf,
                                &mut conn.write_buf,
                            ) {
                                Ok(true) => {
                                    read_ended = true;
                                    break;
                                }
                                Ok(false) => {}
                                Err(_) => {
                                    conn.close_after_write = true;
                                    break;
                                }
                            }
                        } else {
                            conn.read_buf.extend_from_slice(chunk);
                        }
                        if n < scratch.len() {
                            break;
                        }
                    } else if n == 0 {
                        read_ended = true;
                        break;
                    } else {
                        let err = io::Error::last_os_error();
                        if err.kind() == io::ErrorKind::WouldBlock {
                            break;
                        }
                        if err.kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        remove = true;
                        break;
                    }
                }
                has_buf_plaintext = conn.read_buf.len() > before_len;
            }

            if read_ended {
                conn.read_ended = true;
                conn.eof_at.get_or_insert(now);
                if conn.writable_armed {
                    if !epoll_ctl_mod(epfd, conn.fd, conn_id, libc::EPOLLOUT as u32) {
                        conn.close_deadline = Some(now);
                    }
                } else {
                    libc::epoll_ctl(epfd, libc::EPOLL_CTL_DEL, conn.fd, std::ptr::null_mut());
                }
            }

            if !remove && (direct_len > 0 || has_buf_plaintext) {
                conn.dispatching = true;
                negotiated_h2 = conn.negotiated_h2();
                let taken = if direct_len > 0 {
                    Vec::new()
                } else {
                    std::mem::take(&mut conn.read_buf)
                };
                let mut sw = std::mem::take(&mut st.scratch_write);
                sw.clear();
                let cb = st.callbacks.take();
                st.dispatching = Some(conn_id);
                dispatch_state = Some((cb, taken, sw));
            } else if !remove
                && (conn.close_after_write
                    || conn.write_pos < conn.write_buf.len()
                    || (events & libc::EPOLLOUT as u32) != 0)
            {
                let fa = flush_write_buf_core(conn);
                if fa == FlushAction::Close {
                    remove = true;
                } else {
                    apply_epoll_flush_action(epfd, conn, conn_id, fa);
                    if fa == FlushAction::DisarmWritable {
                        st.pending_writable.push(conn_id);
                    }
                }
            }
        }
        st.max_incoming_cpus = max_cpus;
        if read_ended {
            if !st.read_ended.contains(&conn_id) {
                st.read_ended.push(conn_id);
            }
            st.turn_dirty = true;
        }
        if dispatch_state.is_none() {
            if remove {
                st.remove_and_close_conn(conn_id);
            }
            if st.read_scratch.is_empty() {
                st.read_scratch = scratch;
            }
            return read_ended;
        }
    }

    let Some((mut cb, mut read_buf, mut cleartext_write)) = dispatch_state else {
        return read_ended;
    };

    let action = if let Some(ref mut handler) = cb {
        let input_slice = if direct_len > 0 {
            std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), direct_len)
        } else {
            &read_buf
        };
        if negotiated_h2 {
            handler.on_h2_negotiated(conn_id);
        }
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
        return false;
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

    let epfd = st.epfd;
    let max_write = write_buf_limit(st.cfg);
    let mut drained_from_bp = false;
    if let Some(conn) = st.conns.get_mut(conn_id) {
        conn.dispatching = false;
        conn.linger |= matches!(action, ConnAction::Refuse { .. });
        if direct_len > 0 {
            let mut progressed = false;
            let leftover_start = match action {
                ConnAction::Continue { consumed } => {
                    progressed = consumed > 0;
                    consumed.min(direct_len)
                }
                ConnAction::CloseAfterWrite { consumed } | ConnAction::Refuse { consumed } => {
                    conn.close_after_write = true;
                    progressed = consumed > 0;
                    consumed.min(direct_len)
                }
                ConnAction::CloseNow => {
                    remove = true;
                    direct_len
                }
            };
            if !remove && leftover_start < direct_len {
                let slice = std::slice::from_raw_parts(scratch.as_ptr().cast::<u8>(), direct_len);
                conn.read_buf.extend_from_slice(&slice[leftover_start..]);
                if progressed || conn.partial_since.is_none() {
                    conn.partial_since = Some(now);
                }
            } else {
                conn.partial_since = None;
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
                    conn.close_after_write = true;
                }
                ConnAction::CloseNow => {
                    remove = true;
                }
            }
            if read_buf.is_empty() && read_buf.capacity() > SHRINK_THRESHOLD {
                read_buf.shrink_to(READ_SCRATCH_SIZE);
            }
            if read_buf.is_empty() {
                conn.partial_since = None;
            } else if progressed || conn.partial_since.is_none() {
                conn.partial_since = Some(now);
            }
            conn.read_buf = read_buf;
        }
        if !remove && !cleartext_write.is_empty() {
            let fa = write_bytes_or_queue(conn, &cleartext_write, max_write);
            if fa == FlushAction::Close || conn.queued_bytes() > max_write {
                remove = true;
            } else if fa != FlushAction::None {
                apply_epoll_flush_action(epfd, conn, conn_id, fa);
                if fa == FlushAction::DisarmWritable {
                    drained_from_bp = true;
                }
            }
        }
        if !remove
            && (conn.close_after_write
                || conn.write_pos < conn.write_buf.len()
                || (events & libc::EPOLLOUT as u32) != 0)
        {
            let fa = flush_write_buf_core(conn);
            if fa == FlushAction::Close {
                remove = true;
            } else {
                apply_epoll_flush_action(epfd, conn, conn_id, fa);
                if fa == FlushAction::DisarmWritable {
                    drained_from_bp = true;
                }
            }
        }
        if !remove && deferred_bp && !conn.writable_armed {
            drained_from_bp = true;
        }
    }
    if drained_from_bp {
        st.pending_writable.push(conn_id);
    }
    if remove {
        st.remove_and_close_conn(conn_id);
    }
    cleartext_write.clear();
    if cleartext_write.capacity() > SHRINK_THRESHOLD {
        cleartext_write.shrink_to(READ_SCRATCH_SIZE);
    }
    st.scratch_write = cleartext_write;
    st.read_scratch = scratch;

    true
}

unsafe fn drain_turn_and_side_effects(state_rc: &Rc<RefCell<EpollState>>) {
    loop {
        let (writable_ids, run_turn, disconnect_ids, mut cb) = {
            let mut st = state_rc.borrow_mut();
            if st.closed {
                return;
            }
            let writable = std::mem::take(&mut st.pending_writable);
            let run_turn = st.turn_dirty;
            st.turn_dirty = false;
            let disconnects = std::mem::take(&mut st.pending_disconnects);
            if writable.is_empty() && !run_turn && disconnects.is_empty() {
                st.disarm_check_if_idle();
                return;
            }
            let Some(cb) = st.callbacks.take() else {
                st.pending_writable = writable;
                if run_turn {
                    st.turn_dirty = true;
                }
                st.pending_disconnects = disconnects;
                return;
            };
            (writable, run_turn, disconnects, cb)
        };

        for id in writable_ids {
            cb.on_writable(id);
        }
        if run_turn {
            cb.on_turn_end();
        }
        for id in disconnect_ids {
            cb.on_disconnect(id);
        }

        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        if run_turn && !st.read_ended.is_empty() {
            let epfd = st.epfd;
            let mut idx = 0usize;
            while idx < st.read_ended.len() {
                let id = st.read_ended[idx];
                if !cb.has_pending_requests(id) {
                    st.read_ended.swap_remove(idx);
                    if let Some(conn) = st.conns.get_mut(id) {
                        conn.close_after_write = true;
                        let fa = flush_write_buf_core(conn);
                        if fa == FlushAction::Close {
                            st.remove_and_close_conn(id);
                        } else if fa != FlushAction::None {
                            apply_epoll_flush_action(epfd, conn, id, fa);
                        }
                    }
                } else {
                    idx += 1;
                }
            }
        }
        st.callbacks = Some(cb);
        if st.pending_writable.is_empty() && !st.turn_dirty && st.pending_disconnects.is_empty() {
            st.disarm_check_if_idle();
            return;
        }
    }
}

#[inline]
unsafe fn dispatch_epoll_client_event(
    state_rc: &Rc<RefCell<EpollState>>,
    epfd: RawFd,
    conn_id: u32,
    mask: u32,
    now: std::time::Instant,
) -> bool {
    if (mask & libc::EPOLLIN as u32) != 0 {
        return handle_client_readable(state_rc, conn_id, mask, now);
    }
    let mut st = state_rc.borrow_mut();
    if st.closed {
        return false;
    }
    if (mask & libc::EPOLLERR as u32) != 0 && (mask & (libc::EPOLLIN | libc::EPOLLOUT) as u32) == 0
    {
        st.remove_and_close_conn(conn_id);
    } else if let Some(conn) = st.conns.get_mut(conn_id) {
        if conn.close_after_write
            || conn.write_pos < conn.write_buf.len()
            || (mask & libc::EPOLLOUT as u32) != 0
        {
            let fa = flush_write_buf_core(conn);
            if fa == FlushAction::Close {
                st.remove_and_close_conn(conn_id);
            } else {
                apply_epoll_flush_action(epfd, conn, conn_id, fa);
                if fa == FlushAction::DisarmWritable {
                    st.pending_writable.push(conn_id);
                }
            }
        }
    }
    false
}

unsafe extern "C" fn on_epoll_event(handle: *mut c_void, status: c_int, _events: c_int) {
    if status < 0 {
        return;
    }
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const EpollCtx);
    let state_rc = Rc::clone(&ctx.state);
    let epfd = ctx.epfd;

    let (max_rounds, flush_chunk, cpu_order, cpu_flush_min, now) = {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        st.in_poll_loop = true;
        let uv_ms = (uv.now)(st.uv_loop);
        let now = st.clock.tick(uv_ms);
        (
            st.max_drain_rounds,
            st.flush_chunk,
            st.cpu_order,
            st.cpu_flush_min,
            now,
        )
    };

    for _round in 0..max_rounds {
        let mut events_buf = {
            let mut st = state_rc.borrow_mut();
            if st.closed {
                st.in_poll_loop = false;
                return;
            }
            let mut buf = std::mem::take(&mut st.events_scratch);
            if buf.len() < MAX_EPOLL_EVENTS {
                buf.resize(MAX_EPOLL_EVENTS, libc::epoll_event { events: 0, u64: 0 });
            }
            buf
        };

        let nevents = libc::epoll_wait(epfd, events_buf.as_mut_ptr(), MAX_EPOLL_EVENTS as c_int, 0);
        if nevents <= 0 {
            let mut st = state_rc.borrow_mut();
            if st.events_scratch.is_empty() {
                st.events_scratch = events_buf;
            }
            break;
        }
        let count = nevents as usize;
        let mut since_flush = 0usize;

        if cpu_order && count > 1 {
            let mut ready = {
                let mut st = state_rc.borrow_mut();
                if st.closed {
                    if st.events_scratch.is_empty() {
                        st.events_scratch = events_buf;
                    }
                    break;
                }
                let mut ready = std::mem::take(&mut st.ready_scratch);
                ready.clear();
                let mod_cpus = st.max_incoming_cpus.max(1);
                let pivot = st.cpu_round % mod_cpus;
                st.cpu_round = st.cpu_round.wrapping_add(1);

                for ev in &events_buf[..count] {
                    if ev.u64 == LISTENER_EVENT_ID {
                        accept_pending(&mut st, now);
                        continue;
                    }
                    let conn_id = ev.u64 as u32;
                    let cpu = st.conns.get(conn_id).map_or(-1, |c| c.incoming_cpu);
                    let bucket = if cpu >= 0 {
                        let c = (cpu as u32).min(mod_cpus - 1);
                        if c >= pivot {
                            c - pivot
                        } else {
                            c + mod_cpus - pivot
                        }
                    } else {
                        mod_cpus
                    };
                    let sort_key = ((bucket as u64) << 32) | u64::from(conn_id);
                    ready.push(ReadyEvent {
                        sort_key,
                        cpu_group: cpu,
                        events: ev.events,
                        conn_id,
                    });
                }
                if st.events_scratch.is_empty() {
                    st.events_scratch = events_buf;
                }
                ready
            };

            if ready.len() > 1 {
                ready.sort_unstable_by_key(|r| r.sort_key);
            }

            let mut cur_cpu: Option<i32> = None;
            for ev in &ready {
                if st_is_closed(&state_rc) {
                    break;
                }
                if cpu_flush_min > 0
                    && since_flush >= cpu_flush_min
                    && ev.cpu_group >= 0
                    && cur_cpu.is_some_and(|c| c != ev.cpu_group)
                {
                    since_flush = 0;
                    drain_turn_and_side_effects(&state_rc);
                }
                if ev.cpu_group >= 0 {
                    cur_cpu = Some(ev.cpu_group);
                }
                if dispatch_epoll_client_event(&state_rc, epfd, ev.conn_id, ev.events, now) {
                    since_flush += 1;
                }
                if since_flush >= flush_chunk {
                    since_flush = 0;
                    drain_turn_and_side_effects(&state_rc);
                }
            }

            {
                let mut st = state_rc.borrow_mut();
                ready.clear();
                if st.ready_scratch.is_empty() {
                    st.ready_scratch = ready;
                }
            }
            drain_turn_and_side_effects(&state_rc);
        } else {
            for ev in &events_buf[..count] {
                if ev.u64 == LISTENER_EVENT_ID {
                    let mut st = state_rc.borrow_mut();
                    if st.closed {
                        break;
                    }
                    accept_pending(&mut st, now);
                    continue;
                }
                if st_is_closed(&state_rc) {
                    break;
                }
                if dispatch_epoll_client_event(&state_rc, epfd, ev.u64 as u32, ev.events, now) {
                    since_flush += 1;
                }
                if since_flush >= flush_chunk {
                    since_flush = 0;
                    drain_turn_and_side_effects(&state_rc);
                }
            }

            {
                let mut st = state_rc.borrow_mut();
                if st.events_scratch.is_empty() {
                    st.events_scratch = events_buf;
                }
            }
            drain_turn_and_side_effects(&state_rc);
        }

        if count < 16 || st_is_closed(&state_rc) {
            break;
        }
    }

    let mut st = state_rc.borrow_mut();
    st.in_poll_loop = false;
    st.disarm_check_if_idle();
}

#[inline]
fn st_is_closed(state_rc: &Rc<RefCell<EpollState>>) -> bool {
    state_rc.borrow().closed
}

unsafe extern "C" fn on_epoll_check(handle: *mut c_void) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const CheckCtx);
    let state_rc = Rc::clone(&ctx.state);
    drain_turn_and_side_effects(&state_rc);
}

unsafe extern "C" fn on_raw_epoll_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        free_handle(handle, uv.poll_size);
    }
}

unsafe extern "C" fn on_epoll_handle_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut EpollCtx);
            if ctx.epfd >= 0 {
                libc::close(ctx.epfd);
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

unsafe extern "C" fn on_timer_event(handle: *mut c_void) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const TimerCtx);
    let state_rc = Rc::clone(&ctx.state);

    let (replies, cb) = {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        let uv_ms = (uv.now)(st.uv_loop);
        if !st.clock.on_timer_tick(uv_ms) {
            return;
        }
        let st = &mut *st;
        let now = st.clock.now();
        let sweep = collect_timeouts(st.conns.iter(), now, st.cfg, st.callbacks.as_deref_mut());
        let epfd = st.epfd;
        let max_write = write_buf_limit(st.cfg);
        let mut close = sweep.close;
        for id in sweep.ping {
            if let Some(conn) = st.conns.get_mut(id) {
                conn.last_activity = now;
                let fa = write_bytes_or_queue(conn, &WS_PING_FRAME, max_write);
                if fa == FlushAction::Close {
                    close.push(id);
                } else {
                    apply_epoll_flush_action(epfd, conn, id, fa);
                }
            }
        }
        for id in close {
            st.remove_and_close_conn(id);
        }
        (sweep.replies, st.callbacks.take())
    };

    if let Some(mut handler) = cb {
        handler.flush_aborted();
        let mut st = state_rc.borrow_mut();
        if !st.closed {
            st.callbacks = Some(handler);
        }
    }
    let server = EpollServer {
        state: Rc::clone(&state_rc),
    };
    for (id, reply) in replies {
        server.write_to_conn(id, &reply, false, false);
    }
    if !state_rc.borrow().pending_disconnects.is_empty() {
        drain_turn_and_side_effects(&state_rc);
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
