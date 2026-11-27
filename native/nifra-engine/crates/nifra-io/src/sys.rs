//! Shared OS/libuv primitives, O(1) generational connection slab, loop-synced clock,
//! and zero-copy read/write helpers for `uv` and Linux `epoll` backends.

#![cfg(any(unix, windows))]

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::ffi::{c_int, c_void};
use std::io;
use std::mem::MaybeUninit;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener as StdTcpListener};
#[cfg(unix)]
use std::os::fd::{AsRawFd, IntoRawFd, OwnedFd, RawFd};
#[cfg(windows)]
use std::os::windows::io::{AsRawSocket, FromRawSocket, IntoRawSocket, OwnedSocket, RawSocket};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
#[cfg(windows)]
use windows_sys::Win32::Networking::WinSock;
#[cfg(windows)]
use windows_sys::Win32::System::LibraryLoader::{
    GetModuleHandleA, GetModuleHandleW, GetProcAddress,
};

use nifra_http::date::{self, ClockLeaseGuard};
use nifra_tls::ServerConnection;

use crate::uv::UvCallbacks;
use crate::SocketConfig;

pub(crate) const UV_CHECK: c_int = 2;
pub(crate) const UV_POLL: c_int = 8;
pub(crate) const UV_TIMER: c_int = 13;

pub(crate) const UV_READABLE: c_int = 1;
pub(crate) const UV_WRITABLE: c_int = 2;

pub(crate) const READ_SCRATCH_SIZE: usize = 64 * 1024;
pub(crate) const SHRINK_THRESHOLD: usize = 64 * 1024;
pub(crate) const MAX_WRITE_BUF_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_READ_PER_EVENT: usize = 256 * 1024;
pub(crate) const DATE_TICK_INTERVAL_MS: u64 = 250;
pub(crate) const IDLE_SWEEP_INTERVAL_MS: u64 = 1_000;
pub(crate) const HALF_CLOSE_GRACE: Duration = Duration::from_millis(250);
pub(crate) const HANDLE_ALIGN: usize = 16;
const SENT_PREFIX_COMPACT_BYTES: usize = 64 * 1024;
/// Unsent output past this stops the connection being read, so a peer that does not read cannot
/// make the server answer (and hold) more.
const WRITE_PAUSE_BYTES: usize = 1024 * 1024;
/// An unmasked, empty RFC 6455 Ping.
pub(crate) const WS_PING_FRAME: [u8; 2] = [0x89, 0x00];

/// Number of low bits reserved for the slot index inside a `conn_id`.
///
/// A retired id is refused only until its slot has been reused `MAX_GEN` times, so the generation
/// takes 12 of the bits a 262,144-connection slab leaves free (keeping bit 30 free for virtual H2 WebSocket ids).
pub const SLOT_BITS: u32 = 18;
pub const SLOT_MASK: u32 = (1 << SLOT_BITS) - 1;
const MAX_SLOTS: usize = 1 << SLOT_BITS;
const MAX_GEN: u16 = 4095; // keeps bits 30..31 = 0 so every conn_id stays below H2_WS_ID_BIT (1 << 30)

/// Extract the direct O(1) slot index from a `conn_id`.
#[inline]
pub const fn conn_slot(conn_id: u32) -> usize {
    (conn_id & SLOT_MASK) as usize
}

pub(crate) type UvPollCb = unsafe extern "C" fn(handle: *mut c_void, status: c_int, events: c_int);
pub(crate) type UvCheckCb = unsafe extern "C" fn(handle: *mut c_void);
pub(crate) type UvTimerCb = unsafe extern "C" fn(handle: *mut c_void);
pub(crate) type UvCloseCb = unsafe extern "C" fn(handle: *mut c_void);

#[cfg(unix)]
pub(crate) type RawSock = RawFd;
#[cfg(unix)]
pub(crate) type OwnedSock = OwnedFd;
#[cfg(unix)]
pub(crate) type UvOsSock = c_int;
#[cfg(unix)]
pub(crate) const INVALID_SOCK: RawSock = -1;

#[cfg(windows)]
pub(crate) type RawSock = RawSocket;
#[cfg(windows)]
pub(crate) type OwnedSock = OwnedSocket;
#[cfg(windows)]
pub(crate) type UvOsSock = usize;
#[cfg(windows)]
pub(crate) const INVALID_SOCK: RawSock = WinSock::INVALID_SOCKET as RawSock;

#[inline]
pub(crate) fn is_valid_sock(sock: RawSock) -> bool {
    #[cfg(unix)]
    {
        sock >= 0
    }
    #[cfg(windows)]
    {
        sock != INVALID_SOCK
    }
}

#[inline]
pub(crate) fn into_raw_sock(sock: OwnedSock) -> RawSock {
    #[cfg(unix)]
    {
        sock.into_raw_fd()
    }
    #[cfg(windows)]
    {
        sock.into_raw_socket()
    }
}

#[inline]
pub(crate) fn as_raw_sock(sock: &OwnedSock) -> RawSock {
    #[cfg(unix)]
    {
        sock.as_raw_fd()
    }
    #[cfg(windows)]
    {
        sock.as_raw_socket()
    }
}

#[inline]
pub(crate) fn tcp_into_owned_sock(listener: StdTcpListener) -> OwnedSock {
    #[cfg(unix)]
    {
        OwnedFd::from(listener)
    }
    #[cfg(windows)]
    {
        OwnedSocket::from(listener)
    }
}

#[inline]
pub(crate) fn to_uv_os_sock(sock: RawSock) -> UvOsSock {
    sock as UvOsSock
}

pub(crate) struct UvApi {
    pub handle_get_data: unsafe extern "C" fn(*const c_void) -> *mut c_void,
    pub handle_set_data: unsafe extern "C" fn(*mut c_void, *mut c_void),
    #[allow(dead_code)]
    pub poll_init: unsafe extern "C" fn(*mut c_void, *mut c_void, c_int) -> c_int,
    pub poll_init_socket: unsafe extern "C" fn(*mut c_void, *mut c_void, UvOsSock) -> c_int,
    pub poll_start: unsafe extern "C" fn(*mut c_void, c_int, UvPollCb) -> c_int,
    pub poll_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub check_init: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    pub check_start: unsafe extern "C" fn(*mut c_void, UvCheckCb) -> c_int,
    pub check_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub timer_init: unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int,
    pub timer_start: unsafe extern "C" fn(*mut c_void, UvTimerCb, u64, u64) -> c_int,
    pub timer_stop: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub now: unsafe extern "C" fn(*const c_void) -> u64,
    pub unref: unsafe extern "C" fn(*mut c_void),
    pub close: unsafe extern "C" fn(*mut c_void, UvCloseCb),
    pub is_closing: unsafe extern "C" fn(*const c_void) -> c_int,
    pub poll_size: usize,
    pub check_size: usize,
    pub timer_size: usize,
}

unsafe impl Send for UvApi {}
unsafe impl Sync for UvApi {}

static UV_API: OnceLock<Result<UvApi, String>> = OnceLock::new();

unsafe fn resolve_sym<T>(name: &'static [u8]) -> Result<T, String> {
    #[cfg(unix)]
    let ptr = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr().cast());
    #[cfg(windows)]
    let ptr = {
        let candidates: [*const u8; 4] = [
            std::ptr::null(),
            b"libnode.dll\0".as_ptr(),
            b"node.dll\0".as_ptr(),
            b"libuv.dll\0".as_ptr(),
        ];
        let mut found: *mut c_void = std::ptr::null_mut();
        for mod_name in candidates {
            let hmod = if mod_name.is_null() {
                GetModuleHandleW(std::ptr::null())
            } else {
                GetModuleHandleA(mod_name)
            };
            if hmod != 0 {
                if let Some(sym) = GetProcAddress(hmod, name.as_ptr()) {
                    found = sym as *mut c_void;
                    break;
                }
            }
        }
        found
    };
    if ptr.is_null() {
        let s = std::str::from_utf8(&name[..name.len() - 1]).unwrap_or("unknown");
        return Err(format!("libuv symbol `{s}` not found in host process"));
    }
    Ok(std::mem::transmute_copy(&ptr))
}

pub(crate) fn uv_api() -> io::Result<&'static UvApi> {
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
            poll_init: resolve_sym(b"uv_poll_init\0")?,
            poll_init_socket: resolve_sym(b"uv_poll_init_socket\0")?,
            poll_start: resolve_sym(b"uv_poll_start\0")?,
            poll_stop: resolve_sym(b"uv_poll_stop\0")?,
            check_init: resolve_sym(b"uv_check_init\0")?,
            check_start: resolve_sym(b"uv_check_start\0")?,
            check_stop: resolve_sym(b"uv_check_stop\0")?,
            timer_init: resolve_sym(b"uv_timer_init\0")?,
            timer_start: resolve_sym(b"uv_timer_start\0")?,
            timer_stop: resolve_sym(b"uv_timer_stop\0")?,
            now: resolve_sym(b"uv_now\0")?,
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

pub(crate) unsafe fn alloc_handle(size: usize) -> *mut c_void {
    let layout = Layout::from_size_align(size, HANDLE_ALIGN).expect("valid handle layout");
    let ptr = alloc_zeroed(layout);
    if ptr.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    ptr.cast()
}

pub(crate) unsafe fn free_handle(ptr: *mut c_void, size: usize) {
    let layout = Layout::from_size_align(size, HANDLE_ALIGN).expect("valid handle layout");
    dealloc(ptr.cast(), layout);
}

#[cfg(unix)]
pub(crate) type SockaddrStorage = libc::sockaddr_storage;
#[cfg(windows)]
pub(crate) type SockaddrStorage = WinSock::SOCKADDR_STORAGE;

#[inline]
pub(crate) unsafe fn peer_ip_from_storage(storage: &SockaddrStorage) -> Option<IpAddr> {
    #[cfg(unix)]
    {
        match storage.ss_family as c_int {
            libc::AF_INET => {
                let sin = &*(storage as *const libc::sockaddr_storage as *const libc::sockaddr_in);
                Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(
                    sin.sin_addr.s_addr,
                ))))
            }
            libc::AF_INET6 => {
                let sin6 =
                    &*(storage as *const libc::sockaddr_storage as *const libc::sockaddr_in6);
                Some(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)))
            }
            _ => None,
        }
    }
    #[cfg(windows)]
    {
        match storage.ss_family {
            WinSock::AF_INET => {
                let sin =
                    &*(storage as *const WinSock::SOCKADDR_STORAGE as *const WinSock::SOCKADDR_IN);
                Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(
                    sin.sin_addr.S_un.S_addr,
                ))))
            }
            WinSock::AF_INET6 => {
                let sin6 =
                    &*(storage as *const WinSock::SOCKADDR_STORAGE as *const WinSock::SOCKADDR_IN6);
                Some(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.u.Byte)))
            }
            _ => None,
        }
    }
}

pub(crate) fn open_spare_fd() -> RawSock {
    #[cfg(unix)]
    {
        unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) }
    }
    #[cfg(windows)]
    {
        INVALID_SOCK
    }
}

#[inline]
pub(crate) unsafe fn close_sock(sock: RawSock) {
    #[cfg(unix)]
    if sock >= 0 {
        libc::close(sock);
    }
    #[cfg(windows)]
    if sock != INVALID_SOCK {
        WinSock::closesocket(sock as WinSock::SOCKET);
    }
}

#[inline]
pub(crate) unsafe fn shutdown_write(sock: RawSock) {
    #[cfg(unix)]
    {
        libc::shutdown(sock, libc::SHUT_WR);
    }
    #[cfg(windows)]
    {
        WinSock::shutdown(sock as WinSock::SOCKET, WinSock::SD_SEND);
    }
}

#[inline]
pub(crate) unsafe fn configure_accepted_socket(sock: RawSock, nodelay: bool) {
    #[cfg(unix)]
    {
        libc::fcntl(sock, libc::F_SETFD, libc::FD_CLOEXEC);
        let flags = libc::fcntl(sock, libc::F_GETFL, 0);
        if flags >= 0 {
            libc::fcntl(sock, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        set_nosigpipe_if_supported(sock);
    }
    #[cfg(windows)]
    {
        let _ = SetHandleInformation(sock as HANDLE, HANDLE_FLAG_INHERIT, 0);
        let mut nonblocking: u32 = 1;
        WinSock::ioctlsocket(sock as WinSock::SOCKET, WinSock::FIONBIO, &mut nonblocking);
    }
    if nodelay {
        set_tcp_nodelay(sock);
    }
}

pub(crate) enum AcceptOutcome {
    Accepted {
        sock: RawSock,
        peer_ip: Option<IpAddr>,
    },
    Emfile,
    Retry,
    WouldBlock,
}

#[inline]
pub(crate) unsafe fn accept_nonblock(listener: RawSock) -> AcceptOutcome {
    let mut storage: SockaddrStorage = std::mem::zeroed();
    #[cfg(unix)]
    {
        let mut addr_len = std::mem::size_of::<SockaddrStorage>() as libc::socklen_t;
        let client_fd = libc::accept(
            listener,
            (&mut storage as *mut SockaddrStorage).cast(),
            &mut addr_len,
        );
        if client_fd >= 0 {
            return AcceptOutcome::Accepted {
                sock: client_fd,
                peer_ip: peer_ip_from_storage(&storage),
            };
        }
        let err = io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EMFILE | libc::ENFILE) => AcceptOutcome::Emfile,
            Some(libc::ECONNABORTED | libc::EPROTO | libc::EINTR) => AcceptOutcome::Retry,
            _ => AcceptOutcome::WouldBlock,
        }
    }
    #[cfg(windows)]
    {
        let mut addr_len = std::mem::size_of::<SockaddrStorage>() as i32;
        let client = WinSock::accept(
            listener as WinSock::SOCKET,
            (&mut storage as *mut SockaddrStorage).cast(),
            &mut addr_len,
        );
        if client != WinSock::INVALID_SOCKET {
            return AcceptOutcome::Accepted {
                sock: client as RawSock,
                peer_ip: peer_ip_from_storage(&storage),
            };
        }
        match WinSock::WSAGetLastError() {
            WinSock::WSAEMFILE | WinSock::WSAENOBUFS => AcceptOutcome::Emfile,
            WinSock::WSAECONNRESET | WinSock::WSAEINTR | WinSock::WSAECONNABORTED => {
                AcceptOutcome::Retry
            }
            _ => AcceptOutcome::WouldBlock,
        }
    }
}

#[inline]
pub(crate) unsafe fn accept_and_discard(listener: RawSock) {
    #[cfg(unix)]
    {
        let shed = libc::accept(listener, std::ptr::null_mut(), std::ptr::null_mut());
        if shed >= 0 {
            libc::close(shed);
        }
    }
    #[cfg(windows)]
    {
        let shed = WinSock::accept(
            listener as WinSock::SOCKET,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if shed != WinSock::INVALID_SOCKET {
            WinSock::closesocket(shed);
        }
    }
}

#[inline]
pub(crate) unsafe fn set_tcp_nodelay(sock: RawSock) -> bool {
    let one: c_int = 1;
    #[cfg(unix)]
    {
        libc::setsockopt(
            sock,
            libc::IPPROTO_TCP,
            libc::TCP_NODELAY,
            (&one as *const c_int).cast(),
            std::mem::size_of::<c_int>() as libc::socklen_t,
        ) == 0
    }
    #[cfg(windows)]
    {
        WinSock::setsockopt(
            sock as WinSock::SOCKET,
            WinSock::IPPROTO_TCP,
            WinSock::TCP_NODELAY,
            (&one as *const c_int).cast(),
            std::mem::size_of::<c_int>() as i32,
        ) == 0
    }
}

#[cfg(unix)]
pub(crate) fn is_sock_nonblocking(sock: RawSock) -> io::Result<bool> {
    let flags = unsafe { libc::fcntl(sock, libc::F_GETFL, 0) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((flags & libc::O_NONBLOCK) != 0)
}

#[cfg(windows)]
#[allow(dead_code)]
pub(crate) fn is_sock_nonblocking(_sock: RawSock) -> io::Result<bool> {
    Ok(true)
}

#[cfg(unix)]
pub fn dup_listener_sock(raw_fd: i32) -> io::Result<OwnedSock> {
    use std::os::fd::FromRawFd;
    if raw_fd < 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "listenerFd must be a non-negative descriptor",
        ));
    }
    let duped = unsafe { libc::fcntl(raw_fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duped < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `F_DUPFD_CLOEXEC` returned a fresh owned file descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(duped) })
}

#[cfg(windows)]
#[allow(dead_code)]
pub fn dup_listener_sock(_raw_fd: i32) -> io::Result<OwnedSock> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "duplicating raw integer listener descriptors is unsupported on Windows",
    ))
}

#[cfg(target_os = "linux")]
#[inline]
pub(crate) unsafe fn socket_incoming_cpu(fd: RawFd) -> i32 {
    let mut cpu: c_int = -1;
    let mut len = std::mem::size_of::<c_int>() as libc::socklen_t;
    if libc::getsockopt(
        fd,
        libc::SOL_SOCKET,
        libc::SO_INCOMING_CPU,
        (&mut cpu as *mut c_int).cast(),
        &mut len,
    ) == 0
    {
        cpu
    } else {
        -1
    }
}

#[cfg(unix)]
#[inline]
pub(crate) unsafe fn set_nosigpipe_if_supported(fd: RawFd) {
    #[cfg(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))]
    {
        let one: c_int = 1;
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&one as *const c_int).cast(),
            std::mem::size_of::<c_int>() as libc::socklen_t,
        );
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    )))]
    let _ = fd;
}

/// Generational O(1) slab replacing `HashMap<u32, Conn>` on the socket hot path.
pub(crate) struct ConnSlab<T> {
    slots: Vec<SlabSlot<T>>,
    free: Vec<u32>,
    len: usize,
}

struct SlabSlot<T> {
    gen: u16,
    entry: Option<T>,
}

impl<T> ConnSlab<T> {
    pub fn with_capacity(cap: usize) -> Self {
        Self {
            slots: Vec::with_capacity(cap),
            free: Vec::with_capacity(cap),
            len: 0,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn alloc_with(&mut self, f: impl FnOnce(u32) -> T) -> Option<u32> {
        let idx = if let Some(idx) = self.free.pop() {
            idx
        } else {
            if self.slots.len() >= MAX_SLOTS {
                return None;
            }
            let idx = self.slots.len() as u32;
            self.slots.push(SlabSlot {
                gen: 1,
                entry: None,
            });
            idx
        };
        let gen = self.slots[idx as usize].gen;
        let id = ((gen as u32) << SLOT_BITS) | idx;
        self.slots[idx as usize].entry = Some(f(id));
        self.len += 1;
        Some(id)
    }

    #[inline]
    pub fn get(&self, conn_id: u32) -> Option<&T> {
        let idx = conn_slot(conn_id);
        let slot = self.slots.get(idx)?;
        if u32::from(slot.gen) != (conn_id >> SLOT_BITS) {
            return None;
        }
        slot.entry.as_ref()
    }

    #[inline]
    pub fn get_mut(&mut self, conn_id: u32) -> Option<&mut T> {
        let idx = conn_slot(conn_id);
        let slot = self.slots.get_mut(idx)?;
        if u32::from(slot.gen) != (conn_id >> SLOT_BITS) {
            return None;
        }
        slot.entry.as_mut()
    }

    #[inline]
    pub fn remove(&mut self, conn_id: u32) -> Option<T> {
        let idx = conn_slot(conn_id);
        let slot = self.slots.get_mut(idx)?;
        if u32::from(slot.gen) != (conn_id >> SLOT_BITS) {
            return None;
        }
        let val = slot.entry.take()?;
        slot.gen = if slot.gen >= MAX_GEN { 1 } else { slot.gen + 1 };
        self.free.push(idx as u32);
        self.len -= 1;
        Some(val)
    }

    #[inline]
    pub fn iter(&self) -> impl Iterator<Item = (u32, &T)> {
        self.slots.iter().enumerate().filter_map(|(idx, slot)| {
            slot.entry
                .as_ref()
                .map(|val| (((slot.gen as u32) << SLOT_BITS) | (idx as u32), val))
        })
    }

    pub fn drain(&mut self) -> Vec<T> {
        let mut out = Vec::with_capacity(self.len);
        for (idx, slot) in self.slots.iter_mut().enumerate() {
            if let Some(val) = slot.entry.take() {
                slot.gen = if slot.gen >= MAX_GEN { 1 } else { slot.gen + 1 };
                self.free.push(idx as u32);
                out.push(val);
            }
        }
        self.len = 0;
        out
    }
}

#[inline]
fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Loop-synchronized clock built on `uv_now()` so I/O hot paths avoid `clock_gettime` syscalls.
pub(crate) struct LoopClock {
    last_uv_ms: u64,
    last_instant: Instant,
    base_uv_ms: u64,
    base_wall_ms: u64,
    last_date_sec: u64,
    last_sweep_ms: u64,
    resync_ticks: u32,
    date_lease: Option<ClockLeaseGuard>,
}

impl LoopClock {
    pub fn new(uv_ms: u64) -> Self {
        let lease = ClockLeaseGuard::new();
        let wall_ms = epoch_millis();
        let sec = wall_ms / 1000;
        date::set_cached_secs(sec);
        Self {
            last_uv_ms: uv_ms,
            last_instant: Instant::now(),
            base_uv_ms: uv_ms,
            base_wall_ms: wall_ms,
            last_date_sec: sec,
            last_sweep_ms: uv_ms,
            resync_ticks: 0,
            date_lease: Some(lease),
        }
    }

    #[inline]
    pub fn tick(&mut self, uv_ms: u64) -> Instant {
        if uv_ms > self.last_uv_ms {
            let delta = uv_ms - self.last_uv_ms;
            self.last_uv_ms = uv_ms;
            self.last_instant += Duration::from_millis(delta);
            let wall_ms = self
                .base_wall_ms
                .saturating_add(uv_ms.saturating_sub(self.base_uv_ms));
            let sec = wall_ms / 1000;
            if sec != self.last_date_sec {
                self.last_date_sec = sec;
                date::set_cached_secs(sec);
            }
        }
        self.last_instant
    }

    #[inline]
    pub fn now(&self) -> Instant {
        self.last_instant
    }

    pub fn on_timer_tick(&mut self, uv_ms: u64) -> bool {
        self.tick(uv_ms);
        self.resync_ticks = self.resync_ticks.wrapping_add(1);
        if self.resync_ticks >= 8 {
            self.resync_ticks = 0;
            let wall_ms = epoch_millis();
            self.base_uv_ms = uv_ms;
            self.base_wall_ms = wall_ms;
            self.last_instant = Instant::now();
            self.last_uv_ms = uv_ms;
            let sec = wall_ms / 1000;
            if sec != self.last_date_sec {
                self.last_date_sec = sec;
                date::set_cached_secs(sec);
            }
        }
        if uv_ms.saturating_sub(self.last_sweep_ms) >= IDLE_SWEEP_INTERVAL_MS {
            self.last_sweep_ms = uv_ms;
            true
        } else {
            false
        }
    }

    pub fn release_date_lease(&mut self) {
        self.date_lease = None;
    }
}

pub(crate) fn alloc_read_scratch() -> Vec<MaybeUninit<u8>> {
    let mut v = Vec::with_capacity(READ_SCRATCH_SIZE);
    // SAFETY: `MaybeUninit<u8>` requires no initialization; callers only read indices written by `recv`.
    unsafe { v.set_len(READ_SCRATCH_SIZE) };
    v
}

#[inline]
pub(crate) fn ensure_read_scratch(scratch: &mut Vec<MaybeUninit<u8>>) {
    if scratch.len() < READ_SCRATCH_SIZE {
        scratch.reserve(READ_SCRATCH_SIZE - scratch.len());
        // SAFETY: elements remain `MaybeUninit<u8>`.
        unsafe { scratch.set_len(READ_SCRATCH_SIZE) };
    }
}

#[inline]
pub(crate) fn recv_nonblock(fd: RawSock, ptr: *mut MaybeUninit<u8>, len: usize) -> isize {
    #[cfg(unix)]
    {
        unsafe { libc::recv(fd, ptr.cast(), len, libc::MSG_DONTWAIT) }
    }
    #[cfg(windows)]
    {
        let max_len = len.min(c_int::MAX as usize) as c_int;
        unsafe { WinSock::recv(fd as WinSock::SOCKET, ptr.cast(), max_len, 0) as isize }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecvErrKind {
    WouldBlock,
    Interrupted,
    Fatal,
}

#[inline]
pub(crate) fn last_recv_error() -> RecvErrKind {
    #[cfg(unix)]
    {
        let err = io::Error::last_os_error();
        match err.kind() {
            io::ErrorKind::WouldBlock => RecvErrKind::WouldBlock,
            io::ErrorKind::Interrupted => RecvErrKind::Interrupted,
            _ => RecvErrKind::Fatal,
        }
    }
    #[cfg(windows)]
    {
        match unsafe { WinSock::WSAGetLastError() } {
            WinSock::WSAEWOULDBLOCK => RecvErrKind::WouldBlock,
            WinSock::WSAEINTR => RecvErrKind::Interrupted,
            _ => RecvErrKind::Fatal,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    All,
    Partial(usize),
    WouldBlock,
    Closed,
}

#[inline]
pub(crate) fn send_nonblock(fd: RawSock, bytes: &[u8]) -> SendOutcome {
    #[cfg(unix)]
    {
        #[cfg(target_os = "linux")]
        const FLAGS: c_int = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;
        #[cfg(not(target_os = "linux"))]
        const FLAGS: c_int = libc::MSG_DONTWAIT;

        loop {
            let n = unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), FLAGS) };
            if n > 0 {
                let written = n as usize;
                if written == bytes.len() {
                    return SendOutcome::All;
                }
                return SendOutcome::Partial(written);
            }
            if n == 0 {
                return SendOutcome::Closed;
            }
            let err = io::Error::last_os_error();
            match err.kind() {
                io::ErrorKind::WouldBlock => return SendOutcome::WouldBlock,
                io::ErrorKind::Interrupted => continue,
                _ => return SendOutcome::Closed,
            }
        }
    }
    #[cfg(windows)]
    {
        let max_len = bytes.len().min(c_int::MAX as usize) as c_int;
        loop {
            let n =
                unsafe { WinSock::send(fd as WinSock::SOCKET, bytes.as_ptr().cast(), max_len, 0) };
            if n > 0 {
                let written = n as usize;
                if written == bytes.len() {
                    return SendOutcome::All;
                }
                return SendOutcome::Partial(written);
            }
            if n == 0 {
                return SendOutcome::Closed;
            }
            match unsafe { WinSock::WSAGetLastError() } {
                WinSock::WSAEWOULDBLOCK => return SendOutcome::WouldBlock,
                WinSock::WSAEINTR => continue,
                _ => return SendOutcome::Closed,
            }
        }
    }
}

pub(crate) struct ConnCore {
    pub fd: RawSock,
    #[cfg(target_os = "linux")]
    pub incoming_cpu: i32,
    #[cfg(target_os = "linux")]
    pub recv_count: u32,
    pub peer_ip: Option<IpAddr>,
    pub tls: Option<ServerConnection>,
    pub read_buf: Vec<u8>,
    pub write_buf: Vec<u8>,
    pub write_pos: usize,
    pub writable_armed: bool,
    pub read_ended: bool,
    pub eof_at: Option<Instant>,
    pub dispatching: bool,
    pub close_after_write: bool,
    /// The close waits for the peer's EOF, for at most `LINGER`.
    pub linger: bool,
    pub last_activity: Instant,
    pub partial_since: Option<Instant>,
    /// When the connection is closed whether or not the peer has answered (a Close handshake's wait).
    pub close_deadline: Option<Instant>,
    pub accepted_at: Instant,
    /// Output is backed up far enough that the socket is not being read.
    pub read_paused: bool,
    /// Application-level read pause (e.g. streaming request body backpressure).
    pub app_read_paused: bool,
    /// Active `ws.cork()` nesting depth deferring socket flushes until the outer callback returns.
    pub cork_depth: u32,
    /// When unsent output last stopped making progress.
    pub stalled_since: Option<Instant>,
}

impl ConnCore {
    #[inline]
    pub fn new(
        fd: RawSock,
        peer_ip: Option<IpAddr>,
        tls: Option<ServerConnection>,
        now: Instant,
    ) -> Self {
        Self {
            fd,
            #[cfg(target_os = "linux")]
            incoming_cpu: -1,
            #[cfg(target_os = "linux")]
            recv_count: 0,
            peer_ip,
            tls,
            read_buf: Vec::new(),
            write_buf: Vec::new(),
            write_pos: 0,
            writable_armed: false,
            read_ended: false,
            eof_at: None,
            dispatching: false,
            close_after_write: false,
            linger: false,
            last_activity: now,
            partial_since: None,
            close_deadline: None,
            accepted_at: now,
            read_paused: false,
            app_read_paused: false,
            cork_depth: 0,
            stalled_since: None,
        }
    }

    #[inline]
    pub fn is_read_paused(&self) -> bool {
        self.read_paused || self.app_read_paused
    }

    #[inline]
    pub fn queued_bytes(&self) -> usize {
        self.write_buf.len().saturating_sub(self.write_pos)
    }

    pub fn queued_output(&self, deferred: usize, deferred_bp: bool, include_corked: bool) -> usize {
        if include_corked || self.cork_depth == 0 {
            return self.queued_bytes() + deferred;
        }
        let socket_backlog = if self.writable_armed {
            self.queued_bytes()
        } else {
            0
        };
        socket_backlog + if deferred_bp { deferred } else { 0 }
    }

    pub fn alpn_protocol(&self) -> Option<Vec<u8>> {
        self.tls
            .as_ref()
            .and_then(|t| t.alpn_protocol().map(|p| p.to_vec()))
    }
}

/// How long a refused peer has to read its answer and stop sending.
const LINGER: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlushAction {
    /// No event mask update needed; connection stays open.
    None,
    /// Arm `WRITABLE` interest.
    ArmWritable,
    /// Disarm `WRITABLE` interest (and emit `on_writable`).
    DisarmWritable,
    /// Close connection cleanly (`close_after_write` or socket error).
    Close,
}

/// Drain `core.write_buf` starting at `write_pos` directly to `core.fd`.
/// The socket took less than was queued: arm writability, and stop or resume reading by how much
/// is left. `ArmWritable` also tells the caller to re-apply the poll mask.
fn backed_up(core: &mut ConnCore, progressed: bool) -> FlushAction {
    if progressed || core.stalled_since.is_none() {
        core.stalled_since = Some(Instant::now());
    }
    let pause = core.queued_bytes() > WRITE_PAUSE_BYTES;
    let changed = pause != core.read_paused;
    core.read_paused = pause;
    if !core.writable_armed || changed {
        core.writable_armed = true;
        return FlushAction::ArmWritable;
    }
    FlushAction::None
}

#[inline]
pub(crate) fn flush_write_buf_core(core: &mut ConnCore) -> FlushAction {
    let mut progressed = false;
    while core.write_pos < core.write_buf.len() {
        let slice = &core.write_buf[core.write_pos..];
        match send_nonblock(core.fd, slice) {
            SendOutcome::All => {
                core.write_pos = core.write_buf.len();
                break;
            }
            SendOutcome::Partial(n) => {
                core.write_pos += n;
                progressed = true;
            }
            SendOutcome::WouldBlock => return backed_up(core, progressed),
            SendOutcome::Closed => return FlushAction::Close,
        }
    }

    core.write_buf.clear();
    core.write_pos = 0;
    core.stalled_since = None;
    core.read_paused = false;
    if core.write_buf.capacity() > SHRINK_THRESHOLD {
        core.write_buf.shrink_to(READ_SCRATCH_SIZE);
    }
    if core.close_after_write {
        if !core.linger || core.read_ended {
            return FlushAction::Close;
        }
        if core.close_deadline.is_none() {
            unsafe { shutdown_write(core.fd) };
            core.close_deadline = Some(Instant::now() + LINGER);
        }
    }
    if core.writable_armed {
        core.writable_armed = false;
        FlushAction::DisarmWritable
    } else {
        FlushAction::None
    }
}

/// Drop the already-sent prefix of a partly drained queue before more is appended, so a stream that
/// always leaves a small tail does not keep every byte it ever sent.
#[inline]
fn compact_sent_prefix(core: &mut ConnCore) {
    if core.write_pos >= SENT_PREFIX_COMPACT_BYTES && core.write_pos * 2 >= core.write_buf.len() {
        core.write_buf.drain(..core.write_pos);
        core.write_pos = 0;
    }
}

/// Write `bytes` synchronously via `send_nonblock` when plaintext and queue-empty,
/// falling back to buffering the tail only on partial writes, backpressure, or TLS.
#[inline]
pub(crate) fn write_buf_limit(cfg: SocketConfig) -> usize {
    if cfg.max_write_buf_bytes > 0 {
        cfg.max_write_buf_bytes
    } else {
        MAX_WRITE_BUF_BYTES
    }
}

/// Write `bytes` synchronously via `send_nonblock` when plaintext and queue-empty,
/// falling back to buffering the tail only on partial writes, backpressure, or TLS.
#[inline]
pub(crate) fn write_bytes_or_queue(
    core: &mut ConnCore,
    bytes: &[u8],
    max_write: usize,
) -> FlushAction {
    let corked = core.cork_depth > 0;
    let queued = core.queued_bytes();
    let mut budget = max_write.saturating_sub(queued);
    let mut prior_action = FlushAction::None;
    if corked && bytes.len() > budget && queued > 0 {
        prior_action = flush_write_buf_core(core);
        if prior_action == FlushAction::Close {
            return FlushAction::Close;
        }
        budget = max_write.saturating_sub(core.queued_bytes());
    }
    if (!corked || bytes.len() > budget)
        && core.tls.is_none()
        && core.write_pos == core.write_buf.len()
        && !bytes.is_empty()
    {
        match send_nonblock(core.fd, bytes) {
            SendOutcome::All => {
                if core.close_after_write || core.writable_armed {
                    let action = flush_write_buf_core(core);
                    if action != FlushAction::None {
                        return action;
                    }
                }
                return prior_action;
            }
            SendOutcome::Partial(n) => {
                let tail = &bytes[n..];
                if tail.len() > budget {
                    return FlushAction::Close;
                }
                core.write_buf.clear();
                core.write_buf.extend_from_slice(tail);
                core.write_pos = 0;
                return backed_up(core, true);
            }
            SendOutcome::WouldBlock => {
                if bytes.len() > budget {
                    return FlushAction::Close;
                }
                core.write_buf.clear();
                core.write_buf.extend_from_slice(bytes);
                core.write_pos = 0;
                return backed_up(core, false);
            }
            SendOutcome::Closed => return FlushAction::Close,
        }
    }

    if bytes.len() > budget {
        return FlushAction::Close;
    }
    compact_sent_prefix(core);
    if let Some(ref mut tls_conn) = core.tls {
        if nifra_tls::encrypt_plaintext(tls_conn, bytes, &mut core.write_buf).is_err() {
            return FlushAction::Close;
        }
    } else {
        core.write_buf.extend_from_slice(bytes);
    }
    if corked && core.queued_bytes() <= max_write {
        return prior_action;
    }
    let action = flush_write_buf_core(core);
    if action == FlushAction::None {
        prior_action
    } else {
        action
    }
}

#[cfg(all(test, unix))]
mod write_tests {
    use super::*;
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    #[test]
    fn cork_overflow_preserves_the_drain_action_after_a_direct_write() {
        let (sender, mut receiver) = UnixStream::pair().unwrap();
        let mut core = ConnCore::new(sender.as_raw_fd(), None, None, Instant::now());
        core.cork_depth = 1;
        core.writable_armed = true;
        core.write_buf.extend_from_slice(b"queued");

        let action = write_bytes_or_queue(&mut core, b"direct write", 8);
        assert_eq!(action, FlushAction::DisarmWritable);
        assert_eq!(core.queued_bytes(), 0);
        let mut output = [0; 18];
        receiver.read_exact(&mut output).unwrap();
        assert_eq!(&output, b"queueddirect write");
    }
}

/// What one idle sweep decided.
#[derive(Default)]
pub(crate) struct Sweep {
    pub close: Vec<u32>,
    /// Quiet WebSockets to probe before judging them.
    pub ping: Vec<u32>,
    pub replies: Vec<(u32, Vec<u8>)>,
}

pub(crate) fn collect_timeouts<'a>(
    conns: impl Iterator<Item = (u32, &'a ConnCore)>,
    now: Instant,
    cfg: SocketConfig,
    mut callbacks: Option<&mut (dyn UvCallbacks + 'static)>,
) -> Sweep {
    let limit = |ms: u64| (ms > 0).then(|| Duration::from_millis(ms));
    let idle_limit = limit(cfg.idle_timeout_ms);
    let response_limit = limit(cfg.response_timeout_ms.unwrap_or(cfg.idle_timeout_ms));
    let ws_lifetime_limit = limit(cfg.ws_max_lifetime_ms);
    let request_limit = limit(cfg.request_timeout_ms);
    // A request head (and a TLS handshake before it) gets the shorter of the two budgets.
    let head_limit = limit(cfg.headers_timeout_ms)
        .into_iter()
        .chain(request_limit)
        .min();
    let past = |since: Instant, limit: Option<Duration>| {
        limit.is_some_and(|l| now.saturating_duration_since(since) >= l)
    };

    let mut idle = Vec::new();
    let mut overdue = Vec::new();
    let mut abandoned = Vec::new();
    let mut replies = Vec::new();
    let mut reply = Vec::new();

    for (id, c) in conns {
        if past(c.accepted_at, ws_lifetime_limit)
            && callbacks.as_deref().is_some_and(|cb| cb.is_websocket(id))
        {
            overdue.push(id);
        }
        if c.queued_bytes() == 0 && past(c.last_activity, idle_limit) {
            idle.push(id);
        }
        if c.partial_since.is_some_and(|at| past(at, request_limit))
            || (request_limit.is_some()
                && callbacks
                    .as_deref_mut()
                    .is_some_and(|cb| cb.expire_requests(id, now, &mut reply)))
        {
            overdue.push(id);
            reply.clear();
        } else if !reply.is_empty() {
            replies.push((id, std::mem::take(&mut reply)));
        }
        if c.tls.as_ref().is_some_and(|tls| tls.is_handshaking()) && past(c.accepted_at, head_limit)
        {
            overdue.push(id);
        }
        let head_pending = c.partial_since.is_some_and(|at| past(at, head_limit))
            && callbacks.as_deref().is_some_and(|cb| cb.reads_http1(id))
            && !c.read_buf.windows(4).any(|w| w == b"\r\n\r\n");
        if head_pending
            || callbacks
                .as_deref()
                .and_then(|cb| cb.oldest_incomplete_head(id))
                .is_some_and(|at| past(at, head_limit))
        {
            overdue.push(id);
        }
        // A peer that takes none of what it asked for is gone, whatever is still owed to it.
        let stalled = [
            c.stalled_since,
            callbacks
                .as_deref()
                .and_then(|cb| cb.output_stalled_since(id)),
        ];
        if stalled
            .into_iter()
            .flatten()
            .any(|at| past(at, response_limit))
        {
            overdue.push(id);
        }
        if c.close_deadline.is_some_and(|d| now >= d) {
            overdue.push(id);
        }
        if past_grace(c.eof_at, now) {
            abandoned.push(id);
        }
    }

    let close = match callbacks.as_deref() {
        Some(cb) if !idle.is_empty() => cb.without_pending(idle),
        _ => idle,
    };
    let mut sweep = Sweep {
        close,
        ping: Vec::new(),
        replies,
    };
    if let Some(cb) = callbacks {
        sweep.close.retain(|&id| {
            let probe = cb.probe_idle(id);
            if probe {
                sweep.ping.push(id);
            }
            !probe
        });
        for id in abandoned {
            if cb.unanswered_only(id) {
                overdue.push(id);
            }
        }
    }
    sweep.close.extend(overdue);
    sweep.close.sort_unstable();
    sweep.close.dedup();
    sweep
        .ping
        .retain(|id| sweep.close.binary_search(id).is_err());
    sweep
        .replies
        .retain(|(id, _)| sweep.close.binary_search(id).is_err());
    sweep
}

fn past_grace(eof_at: Option<Instant>, now: Instant) -> bool {
    eof_at.is_some_and(|at| now.duration_since(at) >= HALF_CLOSE_GRACE)
}
