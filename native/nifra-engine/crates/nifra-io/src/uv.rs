//! Zero-hop `libuv` (`uv_poll_t` + `uv_check_t`) driver and Linux `epoll` facade running on
//! Node.js's main event loop, with optional sans-I/O `rustls` TLS termination and hot reload.

#![cfg(unix)]

use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::{c_int, c_void};
use std::io;
use std::mem::MaybeUninit;
use std::net::TcpListener as StdTcpListener;
use std::os::fd::{AsRawFd, IntoRawFd, RawFd};
use std::rc::Rc;
use std::sync::Arc;

use nifra_tls::{feed_ciphertext, TlsError, TlsInput, TlsStore};

#[cfg(target_os = "linux")]
use crate::epoll::EpollServer;
use crate::sys::{
    alloc_handle, alloc_read_scratch, collect_timeouts, ensure_read_scratch, flush_write_buf_core,
    free_handle, open_spare_fd, peer_ip_from_storage, recv_nonblock, set_nosigpipe_if_supported,
    set_tcp_nodelay, uv_api, write_bytes_or_queue, ConnCore, ConnSlab, FlushAction, LoopClock,
    UvApi, DATE_TICK_INTERVAL_MS, MAX_READ_PER_EVENT, MAX_WRITE_BUF_BYTES, READ_SCRATCH_SIZE,
    SHRINK_THRESHOLD, UV_READABLE, UV_WRITABLE, WS_PING_FRAME,
};
use crate::{ConnAction, SocketConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteResult {
    Written,
    Backpressured,
    Closed,
}

/// Callback hooks invoked synchronously on Node's main V8/libuv thread.
pub trait UvCallbacks {
    fn on_data(&mut self, conn_id: u32, read_buf: &[u8], write_buf: &mut Vec<u8>) -> ConnAction;
    fn on_turn_end(&mut self);
    fn has_pending_requests(&self, conn_id: u32) -> bool;
    /// Drop from `ids` every connection that still owes a response. The idle sweep uses it so a
    /// handler that outlasts the idle timeout is not cut off mid-request.
    fn without_pending(&self, ids: Vec<u32>) -> Vec<u32> {
        ids.into_iter()
            .filter(|id| !self.has_pending_requests(*id))
            .collect()
    }
    /// Whether `conn_id` owes responses and has started none of them. A peer that ended its sending
    /// side and still waits on such a connection past `HALF_CLOSE_GRACE` is treated as gone, as
    /// `node:http` does: the requests are aborted rather than held for a handler that may never finish.
    fn unanswered_only(&self, conn_id: u32) -> bool {
        self.has_pending_requests(conn_id)
    }
    /// Cancel expired protocol requests and append any reply bytes. Returns true if the
    /// connection must close. Runs while the transport is borrowed, so this cannot call JS.
    fn expire_requests(
        &mut self,
        _conn_id: u32,
        _now: std::time::Instant,
        _out: &mut Vec<u8>,
    ) -> bool {
        false
    }
    /// Whether `conn_id` is still speaking HTTP/1.1, so unread bytes are a request.
    fn reads_http1(&self, _conn_id: u32) -> bool {
        true
    }
    /// When a header block that is still arriving began, for protocols that parse it as it comes.
    fn oldest_incomplete_head(&self, _conn_id: u32) -> Option<std::time::Instant> {
        None
    }
    /// Since when response bytes held above the socket (HTTP/2 flow control) have not moved.
    fn output_stalled_since(&self, _conn_id: u32) -> Option<std::time::Instant> {
        None
    }
    /// An idle connection about to be closed. `true` sends it a Ping and gives it another window.
    fn probe_idle(&self, _conn_id: u32) -> bool {
        false
    }
    fn on_writable(&mut self, conn_id: u32);
    fn on_disconnect(&mut self, conn_id: u32);
}

enum ServerBackend {
    Uv(Rc<RefCell<UvPollState>>),
    #[cfg(target_os = "linux")]
    Epoll(EpollServer),
}

/// Zero-hop HTTP/HTTPS server handle attached directly to Node.js's `uv_loop_t`.
pub struct UvServer {
    backend: ServerBackend,
}

impl UvServer {
    /// # Safety
    /// `uv_loop` must point to the live `uv_loop_t` of the calling thread and outlive the server.
    pub unsafe fn start(
        uv_loop: *mut c_void,
        listener: StdTcpListener,
        cfg: SocketConfig,
        callbacks: Box<dyn UvCallbacks>,
    ) -> io::Result<Self> {
        Self::start_with_tls(uv_loop, listener, cfg, None, callbacks)
    }

    /// # Safety
    /// `uv_loop` must point to the live `uv_loop_t` of the calling thread and outlive the server.
    pub unsafe fn start_with_tls(
        uv_loop: *mut c_void,
        listener: StdTcpListener,
        cfg: SocketConfig,
        tls: Option<Arc<TlsStore>>,
        callbacks: Box<dyn UvCallbacks>,
    ) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        if std::env::var_os("NIFRA_ENGINE_TRANSPORT").as_deref() != Some(std::ffi::OsStr::new("uv"))
        {
            return Ok(Self {
                backend: ServerBackend::Epoll(EpollServer::start_with_tls(
                    uv_loop, listener, cfg, tls, callbacks,
                )?),
            });
        }
        Ok(Self {
            backend: ServerBackend::Uv(UvPollState::start_with_tls(
                uv_loop, listener, cfg, tls, callbacks,
            )?),
        })
    }

    /// Atomically replace the TLS certificate/key for all future handshakes without dropping open
    /// connections. Returns an error if the server was started without TLS or material is invalid.
    pub fn reload_tls(&self, input: &TlsInput) -> Result<(), TlsError> {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::reload_tls(state, input),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.reload_tls(input),
        }
    }

    pub fn remote_addr(&self, conn_id: u32) -> Option<String> {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::remote_addr(state, conn_id),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.remote_addr(conn_id),
        }
    }

    pub fn has_read_ended(&self, conn_id: u32) -> bool {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::has_read_ended(state, conn_id),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.has_read_ended(conn_id),
        }
    }

    /// Return the negotiated TLS ALPN protocol (e.g. `b"h2"` or `b"http/1.1"`) if TLS is active.
    pub fn alpn_protocol(&self, conn_id: u32) -> Option<Vec<u8>> {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::alpn_protocol(state, conn_id),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.alpn_protocol(conn_id),
        }
    }

    /// Queue plaintext HTTP/WS/H2 bytes to write to `conn_id` (encrypted automatically when TLS is active).
    pub fn write_to_conn(&self, conn_id: u32, bytes: &[u8], close_after: bool) -> WriteResult {
        match &self.backend {
            ServerBackend::Uv(state) => {
                UvPollState::write_to_conn(state, conn_id, bytes, close_after, false)
            }
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.write_to_conn(conn_id, bytes, close_after, false),
        }
    }

    /// HTTP/1.1 hot-path write that checks half-closed `read_ended` in the same connection lookup
    /// when `close_if_read_ended` is true, avoiding a separate `has_read_ended` lock/lookup.
    pub fn write_to_conn_h1(
        &self,
        conn_id: u32,
        bytes: &[u8],
        force_close: bool,
        close_if_read_ended: bool,
    ) -> WriteResult {
        match &self.backend {
            ServerBackend::Uv(state) => {
                UvPollState::write_to_conn(state, conn_id, bytes, force_close, close_if_read_ended)
            }
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => {
                ep.write_to_conn(conn_id, bytes, force_close, close_if_read_ended)
            }
        }
    }

    pub fn close_conn(&self, conn_id: u32) -> bool {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::close_conn(state, conn_id),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.close_conn(conn_id),
        }
    }

    /// Close `conn_id` after `wait` whether or not the peer has finished with it.
    pub fn close_within(&self, conn_id: u32, wait: std::time::Duration) {
        match &self.backend {
            ServerBackend::Uv(state) => {
                let mut st = state.borrow_mut();
                let at = st.clock.now() + wait;
                if let Some(conn) = st.conns.get_mut(conn_id) {
                    conn.core.close_deadline = Some(at);
                }
            }
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.close_within(conn_id, wait),
        }
    }

    /// Whether any connection still holds response bytes it has not yet written to its socket.
    pub fn any_queued(&self) -> bool {
        match &self.backend {
            ServerBackend::Uv(state) => {
                let st = state.borrow();
                // `deferred` holds what a handler wrote during its own dispatch, not yet on any queue.
                !st.deferred.is_empty() || st.conns.iter().any(|(_, c)| c.core.queued_bytes() > 0)
            }
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.any_queued(),
        }
    }

    pub fn stop_listening(&self) {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::stop_listening(state),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.stop_listening(),
        }
    }

    pub fn close_all(&self) {
        match &self.backend {
            ServerBackend::Uv(state) => UvPollState::close_all(state),
            #[cfg(target_os = "linux")]
            ServerBackend::Epoll(ep) => ep.close_all(),
        }
    }
}

struct UvConn {
    core: ConnCore,
    poll_handle: *mut c_void,
}

struct ListenerCtx {
    state: Rc<RefCell<UvPollState>>,
    fd: RawFd,
}

struct ClientCtx {
    state: Rc<RefCell<UvPollState>>,
    conn_id: u32,
    fd: RawFd,
}

struct CheckCtx {
    state: Rc<RefCell<UvPollState>>,
}

struct TimerCtx {
    state: Rc<RefCell<UvPollState>>,
}

struct UvPollState {
    uv: &'static UvApi,
    uv_loop: *mut c_void,
    cfg: SocketConfig,
    tls: Option<Arc<TlsStore>>,
    clock: LoopClock,
    listener_handle: *mut c_void,
    check_handle: *mut c_void,
    timer_handle: *mut c_void,
    conns: ConnSlab<UvConn>,
    read_ended: HashSet<u32>,
    turn_dirty: bool,
    /// Connections an application write drained, owed an `on_writable` once the borrow is released.
    pending_writable: Vec<u32>,
    closed: bool,
    read_scratch: Vec<MaybeUninit<u8>>,
    scratch_write: Vec<u8>,
    spare_fd: RawFd,
    dispatching: Option<u32>,
    deferred: Vec<u8>,
    deferred_close: bool,
    callbacks: Option<Box<dyn UvCallbacks>>,
}

impl UvPollState {
    unsafe fn start_with_tls(
        uv_loop: *mut c_void,
        listener: StdTcpListener,
        cfg: SocketConfig,
        tls: Option<Arc<TlsStore>>,
        callbacks: Box<dyn UvCallbacks>,
    ) -> io::Result<Rc<RefCell<Self>>> {
        if uv_loop.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "null uv_loop_t pointer",
            ));
        }
        let uv = uv_api()?;
        listener.set_nonblocking(true)?;
        let listener_fd = listener.as_raw_fd();
        if cfg.tcp_nodelay {
            set_tcp_nodelay(listener_fd);
        }
        let initial_uv_ms = (uv.now)(uv_loop);

        let state = Rc::new(RefCell::new(Self {
            uv,
            uv_loop,
            cfg,
            tls,
            clock: LoopClock::new(initial_uv_ms),
            listener_handle: std::ptr::null_mut(),
            check_handle: std::ptr::null_mut(),
            timer_handle: std::ptr::null_mut(),
            conns: ConnSlab::with_capacity(256),
            read_ended: HashSet::new(),
            turn_dirty: false,
            pending_writable: Vec::new(),
            closed: false,
            read_scratch: alloc_read_scratch(),
            scratch_write: Vec::with_capacity(16 * 1024),
            spare_fd: open_spare_fd(),
            dispatching: None,
            deferred: Vec::new(),
            deferred_close: false,
            callbacks: Some(callbacks),
        }));

        let poll_handle = alloc_handle(uv.poll_size);
        let rc = (uv.poll_init_socket)(uv_loop, poll_handle, listener_fd);
        if rc != 0 {
            free_handle(poll_handle, uv.poll_size);
            close_spare_fd(&state);
            return Err(io::Error::other(format!(
                "uv_poll_init_socket failed: {rc}"
            )));
        }

        let check_handle = alloc_handle(uv.check_size);
        let rc = (uv.check_init)(uv_loop, check_handle);
        if rc != 0 {
            free_handle(check_handle, uv.check_size);
            (uv.close)(poll_handle, on_raw_poll_close);
            close_spare_fd(&state);
            return Err(io::Error::other(format!("uv_check_init failed: {rc}")));
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

        let fd_owned = listener.into_raw_fd();
        let l_ctx = Box::into_raw(Box::new(ListenerCtx {
            state: Rc::clone(&state),
            fd: fd_owned,
        }));
        (uv.handle_set_data)(poll_handle, l_ctx.cast());

        let c_ctx = Box::into_raw(Box::new(CheckCtx {
            state: Rc::clone(&state),
        }));
        (uv.handle_set_data)(check_handle, c_ctx.cast());

        {
            let mut st = state.borrow_mut();
            st.listener_handle = poll_handle;
            st.check_handle = check_handle;
            st.timer_handle = timer_handle;
        }

        let rc = (uv.poll_start)(poll_handle, UV_READABLE, on_listener_event);
        if rc != 0 {
            Self::close_all(&state);
            return Err(io::Error::other(format!(
                "uv_poll_start(listener) failed: {rc}"
            )));
        }
        let rc = (uv.check_start)(check_handle, on_check_event);
        if rc != 0 {
            Self::close_all(&state);
            return Err(io::Error::other(format!("uv_check_start failed: {rc}")));
        }

        Ok(state)
    }

    fn reload_tls(state: &Rc<RefCell<Self>>, input: &TlsInput) -> Result<(), TlsError> {
        let store = {
            let st = state.borrow();
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

    fn remote_addr(state: &Rc<RefCell<Self>>, conn_id: u32) -> Option<String> {
        state
            .borrow()
            .conns
            .get(conn_id)
            .map(|c| c.core.peer_ip.map_or_else(String::new, |ip| ip.to_string()))
    }

    fn has_read_ended(state: &Rc<RefCell<Self>>, conn_id: u32) -> bool {
        state
            .borrow()
            .conns
            .get(conn_id)
            .is_some_and(|conn| conn.core.read_ended && !conn.core.dispatching)
    }

    fn alpn_protocol(state: &Rc<RefCell<Self>>, conn_id: u32) -> Option<Vec<u8>> {
        state
            .borrow()
            .conns
            .get(conn_id)
            .and_then(|c| c.core.alpn_protocol())
    }

    fn write_to_conn(
        state: &Rc<RefCell<Self>>,
        conn_id: u32,
        bytes: &[u8],
        close_after: bool,
        close_if_read_ended: bool,
    ) -> WriteResult {
        let mut st = state.borrow_mut();
        let uv = st.uv;
        let uv_ms = unsafe { (uv.now)(st.uv_loop) };
        let now = st.clock.tick(uv_ms);
        if st.read_ended.contains(&conn_id) {
            st.turn_dirty = true;
        }
        if st.dispatching == Some(conn_id) {
            if let Some(conn) = st.conns.get(conn_id) {
                let effective_close = close_after
                    || (close_if_read_ended && conn.core.read_ended && !conn.core.dispatching);
                if st.deferred.len().saturating_add(bytes.len()) > MAX_WRITE_BUF_BYTES {
                    if let Some(c) = st.conns.remove(conn_id) {
                        close_client_handle(uv, c.poll_handle);
                    }
                    return WriteResult::Closed;
                }
                st.deferred.extend_from_slice(bytes);
                st.deferred_close |= effective_close;
                return WriteResult::Written;
            }
        }
        let Some(conn) = st.conns.get_mut(conn_id) else {
            return WriteResult::Closed;
        };
        conn.core.last_activity = now;
        let effective_close =
            close_after || (close_if_read_ended && conn.core.read_ended && !conn.core.dispatching);
        if conn.core.queued_bytes().saturating_add(bytes.len()) > MAX_WRITE_BUF_BYTES {
            if let Some(c) = st.conns.remove(conn_id) {
                close_client_handle(uv, c.poll_handle);
            }
            return WriteResult::Closed;
        }
        if effective_close {
            conn.core.close_after_write = true;
        }
        let action = write_bytes_or_queue(&mut conn.core, bytes);
        let armed = conn.core.writable_armed;
        let poll_handle = conn.poll_handle;
        let no_read = conn.core.read_ended || conn.core.read_paused;
        apply_uv_flush_action(uv, poll_handle, no_read, action);
        if action == FlushAction::Close {
            if let Some(c) = st.conns.remove(conn_id) {
                close_client_handle(uv, c.poll_handle);
            }
            return WriteResult::Closed;
        }
        if action == FlushAction::DisarmWritable {
            // A producer waiting for the queue to drain is woken at the turn's end.
            st.pending_writable.push(conn_id);
            st.turn_dirty = true;
        }
        if armed {
            WriteResult::Backpressured
        } else {
            WriteResult::Written
        }
    }

    fn close_conn(state: &Rc<RefCell<Self>>, conn_id: u32) -> bool {
        let mut st = state.borrow_mut();
        let uv = st.uv;
        if let Some(c) = st.conns.remove(conn_id) {
            close_client_handle(uv, c.poll_handle);
            return true;
        }
        false
    }

    fn stop_listening(state: &Rc<RefCell<Self>>) {
        let mut st = state.borrow_mut();
        let uv = st.uv;
        if !st.listener_handle.is_null() {
            let h = st.listener_handle;
            st.listener_handle = std::ptr::null_mut();
            unsafe {
                if (uv.is_closing)(h) == 0 {
                    (uv.poll_stop)(h);
                    (uv.close)(h, on_listener_close);
                }
            }
        }
    }

    fn close_all(state: &Rc<RefCell<Self>>) {
        Self::stop_listening(state);
        let mut st = state.borrow_mut();
        if st.closed {
            return;
        }
        st.closed = true;
        st.clock.release_date_lease();
        let uv = st.uv;
        let drained = st.conns.drain();
        st.read_ended.clear();
        for c in drained {
            close_client_handle(uv, c.poll_handle);
        }
        if !st.check_handle.is_null() {
            let h = st.check_handle;
            st.check_handle = std::ptr::null_mut();
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
        if st.spare_fd >= 0 {
            unsafe { libc::close(st.spare_fd) };
            st.spare_fd = -1;
        }
    }
}

#[inline]
fn apply_uv_flush_action(uv: &UvApi, handle: *mut c_void, no_read: bool, action: FlushAction) {
    unsafe {
        match action {
            FlushAction::ArmWritable => {
                let events = UV_WRITABLE | if no_read { 0 } else { UV_READABLE };
                (uv.poll_start)(handle, events, on_client_event);
            }
            FlushAction::DisarmWritable => {
                if no_read {
                    (uv.poll_stop)(handle);
                } else {
                    (uv.poll_start)(handle, UV_READABLE, on_client_event);
                }
            }
            FlushAction::None | FlushAction::Close => {}
        }
    }
}

fn close_spare_fd(state: &Rc<RefCell<UvPollState>>) {
    let mut st = state.borrow_mut();
    if st.spare_fd >= 0 {
        unsafe { libc::close(st.spare_fd) };
        st.spare_fd = -1;
    }
}

fn close_client_handle(uv: &UvApi, handle: *mut c_void) {
    unsafe {
        if !handle.is_null() && (uv.is_closing)(handle) == 0 {
            (uv.poll_stop)(handle);
            (uv.close)(handle, on_client_close);
        }
    }
}

unsafe extern "C" fn on_listener_event(handle: *mut c_void, status: c_int, _events: c_int) {
    if status < 0 {
        return;
    }
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const ListenerCtx);
    let mut st = ctx.state.borrow_mut();
    if st.closed {
        return;
    }
    let uv_loop = st.uv_loop;
    let nodelay = st.cfg.tcp_nodelay;
    let now = st.clock.tick((uv.now)(uv_loop));

    loop {
        let mut storage: libc::sockaddr_storage = std::mem::zeroed();
        let mut addr_len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        let client_fd = libc::accept(
            ctx.fd,
            (&mut storage as *mut libc::sockaddr_storage).cast(),
            &mut addr_len,
        );
        if client_fd < 0 {
            let err = io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::EMFILE | libc::ENFILE) if st.spare_fd >= 0 => {
                    libc::close(st.spare_fd);
                    let shed = libc::accept(ctx.fd, std::ptr::null_mut(), std::ptr::null_mut());
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
        libc::fcntl(client_fd, libc::F_SETFD, libc::FD_CLOEXEC);
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
        let peer_ip = peer_ip_from_storage(&storage);

        let flags = libc::fcntl(client_fd, libc::F_GETFL, 0);
        if flags >= 0 {
            libc::fcntl(client_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        set_nosigpipe_if_supported(client_fd);
        if nodelay {
            set_tcp_nodelay(client_fd);
        }

        // The slot is taken before libuv is handed the handle: a full slab then frees an
        // uninitialised handle, which libuv does not yet own.
        let poll_handle = alloc_handle(uv.poll_size);
        let Some(conn_id) = st.conns.alloc_with(|_| UvConn {
            core: ConnCore::new(client_fd, peer_ip, tls_conn, now),
            poll_handle,
        }) else {
            free_handle(poll_handle, uv.poll_size);
            libc::close(client_fd);
            continue;
        };
        if (uv.poll_init_socket)(uv_loop, poll_handle, client_fd) != 0 {
            st.conns.remove(conn_id);
            free_handle(poll_handle, uv.poll_size);
            libc::close(client_fd);
            continue;
        }

        let c_ctx = Box::into_raw(Box::new(ClientCtx {
            state: Rc::clone(&ctx.state),
            conn_id,
            fd: client_fd,
        }));
        (uv.handle_set_data)(poll_handle, c_ctx.cast());

        if (uv.poll_start)(poll_handle, UV_READABLE, on_client_event) != 0 {
            st.conns.remove(conn_id);
            (uv.close)(poll_handle, on_client_close);
            continue;
        }
    }
}

unsafe extern "C" fn on_client_event(handle: *mut c_void, status: c_int, events: c_int) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const ClientCtx);
    let conn_id = ctx.conn_id;
    let state_rc = Rc::clone(&ctx.state);

    let mut remove = status < 0;
    let mut read_ended = false;
    let mut direct_len = 0usize;
    let mut has_buf_plaintext = false;
    let mut scratch;
    let now;
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
        let uv_ms = (uv.now)(st.uv_loop);
        now = st.clock.tick(uv_ms);
        scratch = std::mem::take(&mut st.read_scratch);
        ensure_read_scratch(&mut scratch);

        if !remove && (events & UV_READABLE) != 0 {
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
                    has_buf_plaintext = conn.core.read_buf.len() > before_len;
                }

                if read_ended {
                    conn.core.read_ended = true;
                    conn.core.eof_at.get_or_insert(now);
                    if conn.core.writable_armed {
                        (uv.poll_start)(conn.poll_handle, UV_WRITABLE, on_client_event);
                    } else {
                        (uv.poll_stop)(conn.poll_handle);
                    }
                }
            }
        }
        if read_ended {
            st.read_ended.insert(conn_id);
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
            if let Some(conn) = st.conns.get_mut(conn_id) {
                if conn.core.close_after_write
                    || conn.core.write_pos < conn.core.write_buf.len()
                    || (events & UV_WRITABLE) != 0
                {
                    let fa = flush_write_buf_core(&mut conn.core);
                    if fa == FlushAction::Close {
                        remove = true;
                    } else {
                        if fa == FlushAction::DisarmWritable {
                            fire_writable = true;
                        }
                        apply_uv_flush_action(
                            uv,
                            conn.poll_handle,
                            conn.core.read_ended || conn.core.read_paused,
                            fa,
                        );
                    }
                }
            }
        }

        if dispatch_state.is_none() {
            if remove {
                if let Some(conn) = st.conns.remove(conn_id) {
                    close_client_handle(uv, conn.poll_handle);
                }
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
        if let Some(conn) = st.conns.get_mut(conn_id) {
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
                let fa = write_bytes_or_queue(&mut conn.core, &cleartext_write);
                if fa == FlushAction::Close || conn.core.queued_bytes() > MAX_WRITE_BUF_BYTES {
                    remove = true;
                } else if fa != FlushAction::None {
                    if fa == FlushAction::DisarmWritable {
                        fire_writable = true;
                    }
                    apply_uv_flush_action(
                        uv,
                        conn.poll_handle,
                        conn.core.read_ended || conn.core.read_paused,
                        fa,
                    );
                }
            }
            if !remove
                && (conn.core.close_after_write
                    || conn.core.write_pos < conn.core.write_buf.len()
                    || (events & UV_WRITABLE) != 0)
            {
                let fa = flush_write_buf_core(&mut conn.core);
                if fa == FlushAction::Close {
                    remove = true;
                } else {
                    if fa == FlushAction::DisarmWritable {
                        fire_writable = true;
                    }
                    apply_uv_flush_action(
                        uv,
                        conn.poll_handle,
                        conn.core.read_ended || conn.core.read_paused,
                        fa,
                    );
                }
            }
        }
        cleartext_write.clear();
        if cleartext_write.capacity() > SHRINK_THRESHOLD {
            cleartext_write.shrink_to(READ_SCRATCH_SIZE);
        }
        st.scratch_write = cleartext_write;
        st.read_scratch = scratch;
        if remove {
            if let Some(conn) = st.conns.remove(conn_id) {
                close_client_handle(uv, conn.poll_handle);
            }
            return;
        }
    } else if remove {
        return;
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

unsafe extern "C" fn on_check_event(handle: *mut c_void) {
    let Ok(uv) = uv_api() else { return };
    let data = (uv.handle_get_data)(handle);
    if data.is_null() {
        return;
    }
    let ctx = &*(data as *const CheckCtx);
    let state_rc = Rc::clone(&ctx.state);

    let cb = {
        let mut st = state_rc.borrow_mut();
        if st.closed || !st.turn_dirty {
            return;
        }
        st.turn_dirty = false;
        st.callbacks.take()
    };

    if let Some(mut handler) = cb {
        handler.on_turn_end();
        let writable = std::mem::take(&mut state_rc.borrow_mut().pending_writable);
        for id in writable {
            if state_rc.borrow().conns.get(id).is_some() {
                handler.on_writable(id);
            }
        }
        let mut st = state_rc.borrow_mut();
        if !st.closed {
            let finished: Vec<u32> = st
                .read_ended
                .iter()
                .copied()
                .filter(|id| !handler.has_pending_requests(*id))
                .collect();
            for id in finished {
                st.read_ended.remove(&id);
                if let Some(conn) = st.conns.get_mut(id) {
                    conn.core.close_after_write = true;
                    let fa = flush_write_buf_core(&mut conn.core);
                    if fa == FlushAction::Close {
                        if let Some(conn) = st.conns.remove(id) {
                            close_client_handle(uv, conn.poll_handle);
                        }
                    } else if fa != FlushAction::None {
                        apply_uv_flush_action(
                            uv,
                            conn.poll_handle,
                            conn.core.read_ended || conn.core.read_paused,
                            fa,
                        );
                    }
                }
            }
            st.callbacks = Some(handler);
        }
    }
}

unsafe extern "C" fn on_raw_poll_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        free_handle(handle, uv.poll_size);
    }
}

unsafe extern "C" fn on_listener_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut ListenerCtx);
            libc::close(ctx.fd);
            drop(ctx);
        }
        free_handle(handle, uv.poll_size);
    }
}

unsafe extern "C" fn on_client_close(handle: *mut c_void) {
    if let Ok(uv) = uv_api() {
        let data = (uv.handle_get_data)(handle);
        if !data.is_null() {
            let ctx = Box::from_raw(data as *mut ClientCtx);
            libc::close(ctx.fd);
            let callbacks = {
                let mut st = ctx.state.borrow_mut();
                st.read_ended.remove(&ctx.conn_id);
                st.callbacks.take()
            };
            if let Some(mut callbacks) = callbacks {
                callbacks.on_disconnect(ctx.conn_id);
                let mut st = ctx.state.borrow_mut();
                if !st.closed {
                    st.callbacks = Some(callbacks);
                }
            }
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

    let mut st = state_rc.borrow_mut();
    if st.closed {
        return;
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
    let mut close = sweep.close;
    for id in sweep.ping {
        if let Some(conn) = st.conns.get_mut(id) {
            conn.core.last_activity = now;
            let fa = write_bytes_or_queue(&mut conn.core, &WS_PING_FRAME);
            if fa == FlushAction::Close {
                close.push(id);
            } else {
                let no_read = conn.core.read_ended || conn.core.read_paused;
                apply_uv_flush_action(uv, conn.poll_handle, no_read, fa);
            }
        }
    }
    for id in close {
        if let Some(conn) = st.conns.remove(id) {
            close_client_handle(uv, conn.poll_handle);
        }
    }
    drop(st);
    for (id, reply) in sweep.replies {
        UvPollState::write_to_conn(&state_rc, id, &reply, false, false);
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
