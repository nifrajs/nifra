//! Zero-hop `libuv` (`uv_poll_t` + `uv_check_t`) driver running directly on Node.js's main event
//! loop, with optional sans-I/O `rustls` TLS termination and atomic hot certificate reload.

#![cfg(unix)]

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_int, c_void};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener as StdTcpListener};
use std::os::fd::{AsRawFd, IntoRawFd, RawFd};
use std::rc::Rc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use nifra_tls::{
    encrypt_plaintext, feed_ciphertext, ServerConnection, TlsError, TlsInput, TlsStore,
};

use crate::{ConnAction, SocketConfig};

const UV_CHECK: c_int = 2;
const UV_POLL: c_int = 8;
const UV_TIMER: c_int = 13;

const UV_READABLE: c_int = 1;
const UV_WRITABLE: c_int = 2;

const READ_SCRATCH_SIZE: usize = 16 * 1024;
const SHRINK_THRESHOLD: usize = 64 * 1024;
const MAX_WRITE_BUF_BYTES: usize = 16 * 1024 * 1024;
/// Bytes read from one socket per poll event. The poll is level-triggered, so leftovers wake the next
/// turn; the cap keeps one fast sender from growing `read_buf` without bound or starving the loop.
const MAX_READ_PER_EVENT: usize = 256 * 1024;
const IDLE_SWEEP_INTERVAL_MS: u64 = 1_000;
/// How long a peer that has stopped sending keeps its unanswered requests alive: long enough for a
/// handler that settles a moment after the request, short enough that a client that hung up (a closed
/// socket looks the same as a half-closed one until a write fails) does not hold a handler slot.
const HALF_CLOSE_GRACE: Duration = Duration::from_millis(250);
const HANDLE_ALIGN: usize = 16;

type UvPollCb = unsafe extern "C" fn(handle: *mut c_void, status: c_int, events: c_int);
type UvCheckCb = unsafe extern "C" fn(handle: *mut c_void);
type UvTimerCb = unsafe extern "C" fn(handle: *mut c_void);
type UvCloseCb = unsafe extern "C" fn(handle: *mut c_void);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteResult {
    Written,
    Backpressured,
    Closed,
}

struct UvApi {
    handle_get_data: unsafe extern "C" fn(*const c_void) -> *mut c_void,
    handle_set_data: unsafe extern "C" fn(*mut c_void, *mut c_void),
    poll_init_socket: unsafe extern "C" fn(*mut c_void, *mut c_void, c_int) -> c_int,
    poll_start: unsafe extern "C" fn(*mut c_void, c_int, UvPollCb) -> c_int,
    poll_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    check_init: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    check_start: unsafe extern "C" fn(*mut c_void, UvCheckCb) -> c_int,
    check_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    timer_init: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    timer_start: unsafe extern "C" fn(*mut c_void, UvTimerCb, u64, u64) -> c_int,
    timer_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    unref: unsafe extern "C" fn(*mut c_void),
    close: unsafe extern "C" fn(*mut c_void, UvCloseCb),
    is_closing: unsafe extern "C" fn(*const c_void) -> c_int,
    poll_size: usize,
    check_size: usize,
    timer_size: usize,
}

unsafe impl Send for UvApi {}
unsafe impl Sync for UvApi {}

static UV_API: OnceLock<Result<UvApi, String>> = OnceLock::new();

unsafe fn resolve_sym<T>(name: &'static [u8]) -> Result<T, String> {
    let ptr = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr().cast());
    if ptr.is_null() {
        let s = std::str::from_utf8(&name[..name.len() - 1]).unwrap_or("unknown");
        return Err(format!("libuv symbol `{s}` not found in host process"));
    }
    Ok(std::mem::transmute_copy(&ptr))
}

fn uv_api() -> io::Result<&'static UvApi> {
    let res = UV_API.get_or_init(|| unsafe {
        let handle_size: unsafe extern "C" fn(c_int) -> usize = resolve_sym(b"uv_handle_size\0")?;
        let poll_size = handle_size(UV_POLL);
        let check_size = handle_size(UV_CHECK);
        let timer_size = handle_size(UV_TIMER);
        if poll_size == 0 || check_size == 0 || timer_size == 0 {
            return Err("uv_handle_size returned 0".into());
        }
        Ok(UvApi {
            handle_get_data: resolve_sym(b"uv_handle_get_data\0")?,
            handle_set_data: resolve_sym(b"uv_handle_set_data\0")?,
            poll_init_socket: resolve_sym(b"uv_poll_init_socket\0")?,
            poll_start: resolve_sym(b"uv_poll_start\0")?,
            poll_stop: resolve_sym(b"uv_poll_stop\0")?,
            check_init: resolve_sym(b"uv_check_init\0")?,
            check_start: resolve_sym(b"uv_check_start\0")?,
            check_stop: resolve_sym(b"uv_check_stop\0")?,
            timer_init: resolve_sym(b"uv_timer_init\0")?,
            timer_start: resolve_sym(b"uv_timer_start\0")?,
            timer_stop: resolve_sym(b"uv_timer_stop\0")?,
            unref: resolve_sym(b"uv_unref\0")?,
            close: resolve_sym(b"uv_close\0")?,
            is_closing: resolve_sym(b"uv_is_closing\0")?,
            poll_size,
            check_size,
            timer_size,
        })
    });
    match res {
        Ok(api) => Ok(api),
        Err(msg) => Err(io::Error::new(io::ErrorKind::Unsupported, msg.clone())),
    }
}

unsafe fn alloc_handle(size: usize) -> *mut c_void {
    let layout = Layout::from_size_align(size, HANDLE_ALIGN).expect("valid handle layout");
    let ptr = alloc_zeroed(layout);
    if ptr.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    ptr.cast()
}

unsafe fn free_handle(ptr: *mut c_void, size: usize) {
    let layout = Layout::from_size_align(size, HANDLE_ALIGN).expect("valid handle layout");
    dealloc(ptr.cast(), layout);
}

unsafe fn format_peer_ip(storage: &libc::sockaddr_storage) -> String {
    match storage.ss_family as c_int {
        libc::AF_INET => {
            let sin = &*(storage as *const libc::sockaddr_storage as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
            IpAddr::V4(ip).to_string()
        }
        libc::AF_INET6 => {
            let sin6 = &*(storage as *const libc::sockaddr_storage as *const libc::sockaddr_in6);
            let ip = Ipv6Addr::from(sin6.sin6_addr.s6_addr);
            IpAddr::V6(ip).to_string()
        }
        _ => String::new(),
    }
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
    fn on_writable(&mut self, conn_id: u32);
    fn on_disconnect(&mut self, conn_id: u32);
}

struct UvConn {
    fd: RawFd,
    remote_addr: String,
    poll_handle: *mut c_void,
    tls: Option<ServerConnection>,
    read_buf: Vec<u8>,
    write_buf: Vec<u8>,
    write_pos: usize,
    writable_armed: bool,
    read_ended: bool,
    /// When the peer's end of the stream was first seen.
    eof_at: Option<Instant>,
    dispatching: bool,
    close_after_write: bool,
    last_activity: Instant,
    /// When the oldest unfinished request still in `read_buf` began arriving.
    partial_since: Option<Instant>,
}

struct ListenerCtx {
    state: Rc<RefCell<UvServerState>>,
    fd: RawFd,
}

struct ClientCtx {
    state: Rc<RefCell<UvServerState>>,
    conn_id: u32,
    fd: RawFd,
}

struct CheckCtx {
    state: Rc<RefCell<UvServerState>>,
}

struct TimerCtx {
    state: Rc<RefCell<UvServerState>>,
}

struct UvServerState {
    uv: &'static UvApi,
    uv_loop: *mut c_void,
    cfg: SocketConfig,
    tls: Option<Arc<TlsStore>>,
    listener_handle: *mut c_void,
    check_handle: *mut c_void,
    timer_handle: *mut c_void,
    conns: HashMap<u32, UvConn>,
    read_ended: HashSet<u32>,
    next_conn_id: u32,
    turn_dirty: bool,
    closed: bool,
    scratch_write: Vec<u8>,
    /// A descriptor held in reserve so that, out of file descriptors, the accept loop can free one,
    /// take the waiting connection and close it instead of spinning on a ready listener.
    spare_fd: RawFd,
    /// The connection whose `on_data` is running. Anything written to it meanwhile (a handler that
    /// answers synchronously) is parked here and appended after the handler's own output, which is the
    /// order the requests arrived in.
    dispatching: Option<u32>,
    deferred: Vec<u8>,
    deferred_close: bool,
    callbacks: Option<Box<dyn UvCallbacks>>,
}

/// Zero-hop HTTP/HTTPS server handle attached directly to Node.js's `uv_loop_t`.
pub struct UvServer {
    state: Rc<RefCell<UvServerState>>,
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
        if uv_loop.is_null() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "null uv_loop_t pointer",
            ));
        }
        let uv = uv_api()?;
        let listener_fd = listener.as_raw_fd();

        let state = Rc::new(RefCell::new(UvServerState {
            uv,
            uv_loop,
            cfg,
            tls,
            listener_handle: std::ptr::null_mut(),
            check_handle: std::ptr::null_mut(),
            timer_handle: std::ptr::null_mut(),
            conns: HashMap::with_capacity(256),
            read_ended: HashSet::new(),
            next_conn_id: 1,
            turn_dirty: false,
            closed: false,
            scratch_write: Vec::with_capacity(READ_SCRATCH_SIZE),
            spare_fd: open_spare_fd(),
            dispatching: None,
            deferred: Vec::new(),
            deferred_close: false,
            callbacks: Some(callbacks),
        }));

        unsafe {
            let poll_handle = alloc_handle(uv.poll_size);
            let rc = (uv.poll_init_socket)(uv_loop, poll_handle, listener_fd);
            if rc != 0 {
                free_handle(poll_handle, uv.poll_size);
                return Err(io::Error::other(format!(
                    "uv_poll_init_socket failed: {rc}"
                )));
            }

            let check_handle = alloc_handle(uv.check_size);
            let rc = (uv.check_init)(uv_loop, check_handle);
            if rc != 0 {
                free_handle(check_handle, uv.check_size);
                (uv.close)(poll_handle, on_raw_poll_close);
                return Err(io::Error::other(format!("uv_check_init failed: {rc}")));
            }

            let timer_handle = if cfg.idle_timeout_ms > 0 || cfg.request_timeout_ms > 0 {
                let th = alloc_handle(uv.timer_size);
                if (uv.timer_init)(uv_loop, th) == 0 {
                    let t_ctx = Box::into_raw(Box::new(TimerCtx {
                        state: Rc::clone(&state),
                    }));
                    (uv.handle_set_data)(th, t_ctx.cast());
                    (uv.unref)(th);
                    let _ = (uv.timer_start)(
                        th,
                        on_timer_event,
                        IDLE_SWEEP_INTERVAL_MS,
                        IDLE_SWEEP_INTERVAL_MS,
                    );
                    th
                } else {
                    free_handle(th, uv.timer_size);
                    std::ptr::null_mut()
                }
            } else {
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
                Self {
                    state: Rc::clone(&state),
                }
                .close_all();
                return Err(io::Error::other(format!(
                    "uv_poll_start(listener) failed: {rc}"
                )));
            }
            let rc = (uv.check_start)(check_handle, on_check_event);
            if rc != 0 {
                Self {
                    state: Rc::clone(&state),
                }
                .close_all();
                return Err(io::Error::other(format!("uv_check_start failed: {rc}")));
            }
        }

        Ok(Self { state })
    }

    /// Atomically replace the TLS certificate/key for all future handshakes without dropping open
    /// connections. Returns an error if the server was started without TLS or material is invalid.
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

    pub fn remote_addr(&self, conn_id: u32) -> Option<String> {
        self.state
            .borrow()
            .conns
            .get(&conn_id)
            .map(|c| c.remote_addr.clone())
    }

    pub fn has_read_ended(&self, conn_id: u32) -> bool {
        self.state.borrow().conns.get(&conn_id).is_some_and(|conn| {
            // A full ring may flush before the rest of the same read has been dispatched.
            conn.read_ended && !conn.dispatching
        })
    }

    /// Return the negotiated TLS ALPN protocol (e.g. `b"h2"` or `b"http/1.1"`) if TLS is active.
    pub fn alpn_protocol(&self, conn_id: u32) -> Option<Vec<u8>> {
        self.state
            .borrow()
            .conns
            .get(&conn_id)
            .and_then(|c| c.tls.as_ref())
            .and_then(|t| t.alpn_protocol().map(|p| p.to_vec()))
    }

    /// Queue plaintext HTTP/WS/H2 bytes to write to `conn_id` (encrypted automatically when TLS is active).
    pub fn write_to_conn(&self, conn_id: u32, bytes: &[u8], close_after: bool) -> WriteResult {
        let mut st = self.state.borrow_mut();
        let uv = st.uv;
        if st.read_ended.contains(&conn_id) {
            st.turn_dirty = true;
        }
        if st.dispatching == Some(conn_id) && st.conns.contains_key(&conn_id) {
            if st.deferred.len().saturating_add(bytes.len()) > MAX_WRITE_BUF_BYTES {
                if let Some(c) = st.conns.remove(&conn_id) {
                    close_client_handle(uv, c.poll_handle);
                }
                return WriteResult::Closed;
            }
            st.deferred.extend_from_slice(bytes);
            st.deferred_close |= close_after;
            return WriteResult::Written;
        }
        let Some(conn) = st.conns.get_mut(&conn_id) else {
            return WriteResult::Closed;
        };
        conn.last_activity = Instant::now();
        // Bound queued outbound bytes per connection to protect against slow-reader OOM.
        let queued = conn.write_buf.len().saturating_sub(conn.write_pos);
        if queued.saturating_add(bytes.len()) > MAX_WRITE_BUF_BYTES {
            if let Some(c) = st.conns.remove(&conn_id) {
                close_client_handle(uv, c.poll_handle);
            }
            return WriteResult::Closed;
        }
        if let Some(ref mut tls_conn) = conn.tls {
            if encrypt_plaintext(tls_conn, bytes, &mut conn.write_buf).is_err() {
                if let Some(c) = st.conns.remove(&conn_id) {
                    close_client_handle(uv, c.poll_handle);
                }
                return WriteResult::Closed;
            }
        } else {
            conn.write_buf.extend_from_slice(bytes);
        }
        if close_after {
            conn.close_after_write = true;
        }
        let (remove, _drained_from_bp) = flush_conn_write(uv, conn);
        if remove {
            if let Some(c) = st.conns.remove(&conn_id) {
                close_client_handle(uv, c.poll_handle);
            }
            return WriteResult::Closed;
        }
        if conn.writable_armed {
            WriteResult::Backpressured
        } else {
            WriteResult::Written
        }
    }

    pub fn close_conn(&self, conn_id: u32) -> bool {
        let mut st = self.state.borrow_mut();
        let uv = st.uv;
        if let Some(c) = st.conns.remove(&conn_id) {
            close_client_handle(uv, c.poll_handle);
            return true;
        }
        false
    }

    pub fn stop_listening(&self) {
        let mut st = self.state.borrow_mut();
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

    pub fn close_all(&self) {
        self.stop_listening();
        let mut st = self.state.borrow_mut();
        if st.closed {
            return;
        }
        st.closed = true;
        let uv = st.uv;
        let drained: Vec<UvConn> = st.conns.drain().map(|(_, c)| c).collect();
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

fn open_spare_fd() -> RawFd {
    unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) }
}

fn close_client_handle(uv: &UvApi, handle: *mut c_void) {
    unsafe {
        if !handle.is_null() && (uv.is_closing)(handle) == 0 {
            (uv.poll_stop)(handle);
            (uv.close)(handle, on_client_close);
        }
    }
}

fn flush_conn_write(uv: &UvApi, conn: &mut UvConn) -> (bool, bool) {
    while conn.write_pos < conn.write_buf.len() {
        let slice = &conn.write_buf[conn.write_pos..];
        let n = unsafe { libc::write(conn.fd, slice.as_ptr().cast(), slice.len()) };
        if n > 0 {
            conn.write_pos += n as usize;
        } else if n == 0 {
            return (true, false);
        } else {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::Interrupted {
                if !conn.writable_armed {
                    conn.writable_armed = true;
                    unsafe {
                        let events = UV_WRITABLE | if conn.read_ended { 0 } else { UV_READABLE };
                        (uv.poll_start)(conn.poll_handle, events, on_client_event);
                    }
                }
                return (false, false);
            }
            return (true, false);
        }
    }

    conn.write_buf.clear();
    conn.write_pos = 0;
    if conn.write_buf.capacity() > SHRINK_THRESHOLD {
        conn.write_buf.shrink_to(READ_SCRATCH_SIZE);
    }
    if conn.close_after_write {
        return (true, false);
    }
    let was_armed = conn.writable_armed;
    if was_armed {
        conn.writable_armed = false;
        unsafe {
            if conn.read_ended {
                (uv.poll_stop)(conn.poll_handle);
            } else {
                (uv.poll_start)(conn.poll_handle, UV_READABLE, on_client_event);
            }
        }
    }
    (false, was_armed)
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
                    // Shed the waiting connection so the listener stops reporting ready.
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
        let remote_addr = format_peer_ip(&storage);

        let flags = libc::fcntl(client_fd, libc::F_GETFL, 0);
        if flags >= 0 {
            libc::fcntl(client_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        if nodelay {
            let one: c_int = 1;
            libc::setsockopt(
                client_fd,
                libc::IPPROTO_TCP,
                libc::TCP_NODELAY,
                (&one as *const c_int).cast(),
                std::mem::size_of::<c_int>() as libc::socklen_t,
            );
        }

        let poll_handle = alloc_handle(uv.poll_size);
        if (uv.poll_init_socket)(uv_loop, poll_handle, client_fd) != 0 {
            free_handle(poll_handle, uv.poll_size);
            libc::close(client_fd);
            continue;
        }

        // The id counter wraps; a connection old enough to still hold the next id keeps it.
        let conn_id = loop {
            let id = st.next_conn_id;
            st.next_conn_id = id.wrapping_add(1).max(1);
            if !st.conns.contains_key(&id) {
                break id;
            }
        };

        let c_ctx = Box::into_raw(Box::new(ClientCtx {
            state: Rc::clone(&ctx.state),
            conn_id,
            fd: client_fd,
        }));
        (uv.handle_set_data)(poll_handle, c_ctx.cast());

        if (uv.poll_start)(poll_handle, UV_READABLE, on_client_event) != 0 {
            (uv.close)(poll_handle, on_client_close);
            continue;
        }

        st.conns.insert(
            conn_id,
            UvConn {
                fd: client_fd,
                remote_addr,
                poll_handle,
                tls: tls_conn,
                read_buf: Vec::with_capacity(READ_SCRATCH_SIZE),
                write_buf: Vec::with_capacity(READ_SCRATCH_SIZE),
                write_pos: 0,
                writable_armed: false,
                read_ended: false,
                eof_at: None,
                dispatching: false,
                close_after_write: false,
                last_activity: Instant::now(),
                partial_since: None,
            },
        );
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
    let mut scratch = [0u8; READ_SCRATCH_SIZE];

    let mut has_new_plaintext = false;
    let mut read_ended = false;
    {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        if !remove && (events & UV_READABLE) != 0 {
            if let Some(conn) = st.conns.get_mut(&conn_id) {
                let before_len = conn.read_buf.len();
                let mut read_total = 0usize;
                loop {
                    if read_total >= MAX_READ_PER_EVENT {
                        break;
                    }
                    let n = libc::read(conn.fd, scratch.as_mut_ptr().cast(), scratch.len());
                    if n > 0 {
                        read_total += n as usize;
                        conn.last_activity = Instant::now();
                        if let Some(ref mut tls_conn) = conn.tls {
                            match feed_ciphertext(
                                tls_conn,
                                &scratch[..n as usize],
                                &mut conn.read_buf,
                                &mut conn.write_buf,
                            ) {
                                Ok(true) => {
                                    // Peer sent TLS close_notify: it is done sending, not reading, so
                                    // requests it already sent are still answered before the close.
                                    read_ended = true;
                                    break;
                                }
                                Ok(false) => {}
                                Err(_) => {
                                    // Flush TLS alert then close socket.
                                    conn.close_after_write = true;
                                    break;
                                }
                            }
                        } else {
                            conn.read_buf.extend_from_slice(&scratch[..n as usize]);
                        }
                        // A read that did not fill the buffer emptied the socket. The poll is
                        // level-triggered, so more data wakes it again: a second read here would only
                        // come back EAGAIN, one wasted syscall per request.
                        if (n as usize) < scratch.len() {
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
                has_new_plaintext = conn.read_buf.len() > before_len;
                if read_ended {
                    conn.read_ended = true;
                    conn.eof_at.get_or_insert_with(Instant::now);
                    if conn.writable_armed {
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
    }

    if !remove && has_new_plaintext {
        let (mut cb, mut read_buf, is_tls, mut cleartext_write) = {
            let mut st = state_rc.borrow_mut();
            let cb = st.callbacks.take();
            let mut sw = std::mem::take(&mut st.scratch_write);
            sw.clear();
            match st.conns.get_mut(&conn_id) {
                Some(c) => {
                    c.dispatching = true;
                    (cb, std::mem::take(&mut c.read_buf), c.tls.is_some(), sw)
                }
                None => (cb, Vec::new(), false, sw),
            }
        };
        state_rc.borrow_mut().dispatching = Some(conn_id);

        let action = if let Some(ref mut handler) = cb {
            handler.on_data(conn_id, &read_buf, &mut cleartext_write)
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
        // What handlers wrote to this connection while it was being parsed follows what the parser
        // queued for the requests before them.
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
        if let Some(conn) = st.conns.get_mut(&conn_id) {
            conn.dispatching = false;
            let mut progressed = false;
            match action {
                ConnAction::Continue { consumed } => {
                    if consumed > 0 {
                        read_buf.drain(..consumed);
                        progressed = true;
                    }
                }
                ConnAction::CloseAfterWrite { consumed } => {
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
            // Bytes left over are the start of a request that has not finished arriving; its clock
            // starts with the first of them and restarts only when a request completes.
            if read_buf.is_empty() {
                conn.partial_since = None;
            } else if progressed || conn.partial_since.is_none() {
                conn.partial_since = Some(Instant::now());
            }
            conn.read_buf = read_buf;
            if !cleartext_write.is_empty() {
                if is_tls {
                    if let Some(ref mut tls_conn) = conn.tls {
                        if encrypt_plaintext(tls_conn, &cleartext_write, &mut conn.write_buf)
                            .is_err()
                        {
                            remove = true;
                        }
                    }
                } else {
                    conn.write_buf.extend_from_slice(&cleartext_write);
                }
            }
        }
        cleartext_write.clear();
        if cleartext_write.capacity() > SHRINK_THRESHOLD {
            cleartext_write.shrink_to(READ_SCRATCH_SIZE);
        }
        st.scratch_write = cleartext_write;
    }

    let mut fire_writable = false;
    {
        let mut st = state_rc.borrow_mut();
        if !remove {
            if let Some(conn) = st.conns.get_mut(&conn_id) {
                if conn.close_after_write
                    || conn.write_pos < conn.write_buf.len()
                    || (events & UV_WRITABLE) != 0
                {
                    let (should_close, drained_bp) = flush_conn_write(uv, conn);
                    if should_close {
                        remove = true;
                    } else if drained_bp {
                        fire_writable = true;
                    }
                }
            }
        }
        if remove {
            if let Some(conn) = st.conns.remove(&conn_id) {
                close_client_handle(uv, conn.poll_handle);
            }
            return;
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
        let mut st = state_rc.borrow_mut();
        if !st.closed {
            // A peer can finish sending before an asynchronous response is ready.
            let finished: Vec<u32> = st
                .read_ended
                .iter()
                .copied()
                .filter(|id| !handler.has_pending_requests(*id))
                .collect();
            for id in finished {
                st.read_ended.remove(&id);
                if let Some(conn) = st.conns.get_mut(&id) {
                    conn.close_after_write = true;
                    if flush_conn_write(uv, conn).0 {
                        if let Some(conn) = st.conns.remove(&id) {
                            close_client_handle(uv, conn.poll_handle);
                        }
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

    {
        let mut st = state_rc.borrow_mut();
        if st.closed {
            return;
        }
        let now = Instant::now();
        let idle_limit =
            (st.cfg.idle_timeout_ms > 0).then(|| Duration::from_millis(st.cfg.idle_timeout_ms));
        let request_limit = (st.cfg.request_timeout_ms > 0)
            .then(|| Duration::from_millis(st.cfg.request_timeout_ms));
        let idle: Vec<u32> = st
            .conns
            .iter()
            .filter(|(_, c)| idle_limit.is_some_and(|l| now.duration_since(c.last_activity) >= l))
            .map(|(&id, _)| id)
            .collect();
        // A connection that still owes a response is waiting on the handler, not the peer.
        let mut ids = match st.callbacks.as_deref() {
            Some(callbacks) if !idle.is_empty() => callbacks.without_pending(idle),
            _ => idle,
        };
        // A request that has taken too long to arrive is the peer's doing however busy the handlers are.
        ids.extend(st.conns.iter().filter_map(|(&id, c)| {
            let started = c.partial_since?;
            request_limit
                .is_some_and(|l| now.duration_since(started) >= l)
                .then_some(id)
        }));
        // A peer that stopped sending and is still waiting on handlers that have answered nothing.
        let abandoned: Vec<u32> = st
            .conns
            .iter()
            .filter(|(_, c)| {
                c.eof_at
                    .is_some_and(|at| now.duration_since(at) >= HALF_CLOSE_GRACE)
            })
            .map(|(&id, _)| id)
            .collect();
        if let Some(callbacks) = st.callbacks.as_deref() {
            ids.extend(
                abandoned
                    .into_iter()
                    .filter(|&id| callbacks.unanswered_only(id)),
            );
        }
        ids.sort_unstable();
        ids.dedup();
        for &id in &ids {
            if let Some(conn) = st.conns.remove(&id) {
                close_client_handle(uv, conn.poll_handle);
            }
        }
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
