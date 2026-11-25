//! Zero-hop socket and event-loop primitives for Nifra's native engine.
//!
//! - Uses `socket2` for non-blocking TCP sockets (`SO_REUSEPORT`, `TCP_NODELAY`).
//! - Provides a standalone `mio` event-loop driver for pure-Rust benchmarks and tests.
//! - Exposes transport detection and Linux 6.1+ `io_uring` probing hooks for the
//!   `libuv` (`napi_get_uv_event_loop`) integration layer.

#[cfg(target_os = "linux")]
pub mod epoll;
#[cfg(unix)]
pub mod sys;
#[cfg(target_os = "linux")]
pub mod uring;
#[cfg(unix)]
pub mod uv;

#[cfg(unix)]
pub use sys::conn_slot;

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener as StdTcpListener};

use mio::net::{TcpListener, TcpStream};
use mio::{Events, Interest, Poll, Token};
use socket2::{Domain, Protocol, Socket, Type};

const SERVER_TOKEN: Token = Token(0);
const READ_BUF_SIZE: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Epoll,
    LibuvPoll,
    IoUring,
    Mio,
}

impl TransportKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Epoll => "epoll",
            Self::LibuvPoll => "libuv-poll",
            Self::IoUring => "io_uring",
            Self::Mio => "mio",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SocketConfig {
    pub reuse_port: bool,
    pub tcp_nodelay: bool,
    pub backlog: i32,
    /// Idle connection timeout in milliseconds (`0` disables the sweep). Default 30s.
    pub idle_timeout_ms: u64,
    /// Open connections above which a new one is closed at accept (`0` is unlimited).
    pub max_connections: usize,
    /// Most time a request may take to arrive, from its first byte; unlike the idle timeout it does not
    /// reset when more bytes come, so a client dripping one byte at a time is bounded (`0` disables).
    pub request_timeout_ms: u64,
}

impl Default for SocketConfig {
    fn default() -> Self {
        Self {
            // Opt in: with the flag set, any process of the same user can bind the port and take a
            // share of the traffic, and a stale instance keeps answering beside a new one.
            reuse_port: false,
            tcp_nodelay: true,
            backlog: 4096,
            idle_timeout_ms: 30_000,
            max_connections: 0,
            request_timeout_ms: 300_000,
        }
    }
}

/// Probe the preferred I/O transport for the current OS/kernel.
pub fn detect_transport() -> TransportKind {
    #[cfg(target_os = "linux")]
    {
        match std::env::var("NIFRA_ENGINE_TRANSPORT").as_deref() {
            Ok("uring") if probe_io_uring() => return TransportKind::IoUring,
            Ok("uv") => return TransportKind::LibuvPoll,
            _ => return TransportKind::Epoll,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        TransportKind::LibuvPoll
    }
}

#[cfg(target_os = "linux")]
fn probe_io_uring() -> bool {
    io_uring::IoUring::new(8).is_ok()
}

/// Bind a non-blocking TCP listener using `socket2` with `SO_REUSEADDR` and optional `SO_REUSEPORT`.
pub fn bind_tcp_listener(
    host: &str,
    port: u16,
    cfg: SocketConfig,
) -> io::Result<(StdTcpListener, SocketAddr)> {
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    if cfg.reuse_port {
        socket.set_reuse_port(true)?;
    }
    socket.set_nonblocking(true)?;
    socket.bind(&addr.into())?;
    socket.listen(cfg.backlog)?;
    let std_listener: StdTcpListener = socket.into();
    let local_addr = std_listener.local_addr()?;
    Ok((std_listener, local_addr))
}

struct Conn {
    stream: TcpStream,
    read_buf: Vec<u8>,
    write_buf: Vec<u8>,
    write_pos: usize,
    close_after_write: bool,
}

impl Conn {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream,
            read_buf: Vec::with_capacity(READ_BUF_SIZE),
            write_buf: Vec::with_capacity(READ_BUF_SIZE),
            write_pos: 0,
            close_after_write: false,
        }
    }
}

/// Outcome of handling bytes read from a single connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnAction {
    /// Keep reading; `consumed` bytes were processed from `read_buf`.
    Continue { consumed: usize },
    /// Close after flushing `write_buf`; `consumed` bytes were processed.
    CloseAfterWrite { consumed: usize },
    /// Close immediately (e.g., protocol error / smuggling attempt).
    CloseNow,
}

/// Run a single-threaded, zero-allocation `mio` server loop.
///
/// The `on_data` callback receives `(read_buf, write_buf)` and appends framed HTTP responses
/// directly to `write_buf`, returning how many bytes were consumed from `read_buf`.
pub fn run_mio_loop<F>(
    std_listener: StdTcpListener,
    cfg: SocketConfig,
    mut on_data: F,
) -> io::Result<()>
where
    F: FnMut(&[u8], &mut Vec<u8>) -> ConnAction,
{
    let mut poll = Poll::new()?;
    let mut events = Events::with_capacity(1024);
    let mut listener = TcpListener::from_std(std_listener);
    poll.registry()
        .register(&mut listener, SERVER_TOKEN, Interest::READABLE)?;

    let mut conns: HashMap<Token, Conn> = HashMap::with_capacity(256);
    let mut next_token: usize = 1;
    let mut scratch = [0u8; READ_BUF_SIZE];

    loop {
        poll.poll(&mut events, None)?;
        for event in events.iter() {
            match event.token() {
                SERVER_TOKEN => loop {
                    match listener.accept() {
                        Ok((mut stream, _addr)) => {
                            if cfg.tcp_nodelay {
                                let _ = stream.set_nodelay(true);
                            }
                            let token = Token(next_token);
                            next_token = next_token.wrapping_add(1).max(1);
                            poll.registry()
                                .register(&mut stream, token, Interest::READABLE)?;
                            conns.insert(token, Conn::new(stream));
                        }
                        Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                        Err(err) => return Err(err),
                    }
                },
                token => {
                    let mut remove = false;
                    if let Some(conn) = conns.get_mut(&token) {
                        if event.is_readable() {
                            loop {
                                match conn.stream.read(&mut scratch) {
                                    Ok(0) => {
                                        remove = true;
                                        break;
                                    }
                                    Ok(n) => {
                                        conn.read_buf.extend_from_slice(&scratch[..n]);
                                    }
                                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                                    Err(_) => {
                                        remove = true;
                                        break;
                                    }
                                }
                            }
                            if !remove && !conn.read_buf.is_empty() {
                                match on_data(&conn.read_buf, &mut conn.write_buf) {
                                    ConnAction::Continue { consumed } => {
                                        if consumed > 0 {
                                            conn.read_buf.drain(..consumed);
                                        }
                                    }
                                    ConnAction::CloseAfterWrite { consumed } => {
                                        if consumed > 0 {
                                            conn.read_buf.drain(..consumed);
                                        }
                                        conn.close_after_write = true;
                                    }
                                    ConnAction::CloseNow => {
                                        remove = true;
                                    }
                                }
                            }
                        }

                        if !remove && conn.write_pos < conn.write_buf.len() {
                            while conn.write_pos < conn.write_buf.len() {
                                match conn.stream.write(&conn.write_buf[conn.write_pos..]) {
                                    Ok(0) => {
                                        remove = true;
                                        break;
                                    }
                                    Ok(n) => conn.write_pos += n,
                                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                                        let _ = poll.registry().reregister(
                                            &mut conn.stream,
                                            token,
                                            Interest::READABLE | Interest::WRITABLE,
                                        );
                                        break;
                                    }
                                    Err(_) => {
                                        remove = true;
                                        break;
                                    }
                                }
                            }
                            if !remove && conn.write_pos == conn.write_buf.len() {
                                conn.write_buf.clear();
                                conn.write_pos = 0;
                                if conn.close_after_write {
                                    remove = true;
                                } else if event.is_writable() {
                                    let _ = poll.registry().reregister(
                                        &mut conn.stream,
                                        token,
                                        Interest::READABLE,
                                    );
                                }
                            }
                        }
                    }
                    if remove {
                        if let Some(mut conn) = conns.remove(&token) {
                            let _ = poll.registry().deregister(&mut conn.stream);
                        }
                    }
                }
            }
        }
    }
}
