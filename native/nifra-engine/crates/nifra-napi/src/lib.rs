//! Thin NAPI-RS bridge exposing Nifra's zero-hop `libuv` HTTP/1.1 server, zero-copy batched
//! shared-memory ABI, lazy header/body accessors, and streaming responses.

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::{sys, NapiRaw, TypedArrayType};
use napi_derive::napi;

use nifra_http::abi::{IN_SLOT_U32S, OUT_SLOT_U32S};
#[cfg(unix)]
use nifra_http::h2::{
    H2Config, H2Conn, H2Event, H2Request, CLIENT_PREFACE, ERR_INTERNAL_ERROR, ERR_NO_ERROR,
};
use nifra_http::{
    awaits_continue, collect_headers_in_head, parse_http1, parse_http1_resume,
    write_block_response, write_buffered_response, write_chunk, write_chunk_terminator,
    write_close_delimited_head, write_stream_head, BatchPacker, ChunkResume, FastRoutes,
    ParseLimits, ParseStatus, PreparedTemplates,
};
#[cfg(unix)]
use nifra_io::conn_slot;
use nifra_io::{bind_tcp_listener, detect_transport, run_mio_loop, ConnAction, SocketConfig};

#[cfg(unix)]
use nifra_io::uv::{UvCallbacks, UvServer, WriteResult};
#[cfg(unix)]
use nifra_tls::{TlsInput, TlsStore};
#[cfg(unix)]
use nifra_ws::{
    compute_accept_key, negotiate_permessage_deflate, validate_upgrade_headers, write_close_frame,
    write_upgrade_response_with_extensions, SharedCompressorPool, WsConfig, WsConn,
    WsDeflateConfig, WsEvent, OPCODE_BINARY, OPCODE_TEXT,
};

const DEFAULT_IN_SLOTS: usize = 256;
const DEFAULT_OUT_SLOTS: usize = 256;
const DEFAULT_IN_DATA_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_OUT_DATA_BYTES: usize = 2 * 1024 * 1024;

struct SharedSlab {
    ptr: *mut u8,
    len: usize,
    align: usize,
}

// The slab is memory shared with JS typed arrays, all on the event-loop thread: `Arc` only shares
// ownership with the external buffer's finalizer, and the `&mut` views below alias that memory by
// design - callers take one view at a time and never hold it across a call into JS.
impl SharedSlab {
    #[allow(clippy::arc_with_non_send_sync)]
    fn new(len: usize, align: usize) -> Arc<Self> {
        let layout = Layout::from_size_align(len, align).expect("valid slab layout");
        let ptr = unsafe { alloc_zeroed(layout) };
        if ptr.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        Arc::new(Self { ptr, len, align })
    }

    #[inline]
    #[allow(clippy::mut_from_ref)]
    unsafe fn as_bytes_mut(&self) -> &mut [u8] {
        std::slice::from_raw_parts_mut(self.ptr, self.len)
    }

    #[inline]
    unsafe fn as_bytes(&self) -> &[u8] {
        std::slice::from_raw_parts(self.ptr, self.len)
    }

    #[inline]
    #[allow(clippy::mut_from_ref)]
    unsafe fn as_u32_mut(&self) -> &mut [u32] {
        std::slice::from_raw_parts_mut(self.ptr.cast::<u32>(), self.len / 4)
    }

    #[inline]
    unsafe fn as_u32(&self) -> &[u32] {
        std::slice::from_raw_parts(self.ptr.cast::<u32>(), self.len / 4)
    }
}

impl Drop for SharedSlab {
    fn drop(&mut self) {
        let layout = Layout::from_size_align(self.len, self.align).expect("valid slab layout");
        unsafe { dealloc(self.ptr, layout) };
    }
}

unsafe extern "C" fn finalize_shared_slab(
    _env: sys::napi_env,
    _finalize_data: *mut c_void,
    finalize_hint: *mut c_void,
) {
    if !finalize_hint.is_null() {
        drop(Arc::from_raw(finalize_hint as *const SharedSlab));
    }
}

fn external_buffer(env: &Env, slab: &Arc<SharedSlab>) -> Result<sys::napi_value> {
    let hint = Arc::into_raw(Arc::clone(slab)) as *mut c_void;
    let mut out = std::ptr::null_mut();
    let status = unsafe {
        sys::napi_create_external_buffer(
            env.raw(),
            slab.len,
            slab.ptr.cast(),
            Some(finalize_shared_slab),
            hint,
            &mut out,
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { drop(Arc::from_raw(hint as *const SharedSlab)) };
        return Err(Error::new(
            Status::GenericFailure,
            format!("napi_create_external_buffer failed: {status}"),
        ));
    }
    Ok(out)
}

fn external_u32_array(env: &Env, slab: &Arc<SharedSlab>) -> Result<sys::napi_value> {
    let hint = Arc::into_raw(Arc::clone(slab)) as *mut c_void;
    let mut ab = std::ptr::null_mut();
    let status = unsafe {
        sys::napi_create_external_arraybuffer(
            env.raw(),
            slab.ptr.cast(),
            slab.len,
            Some(finalize_shared_slab),
            hint,
            &mut ab,
        )
    };
    if status != sys::Status::napi_ok {
        unsafe { drop(Arc::from_raw(hint as *const SharedSlab)) };
        return Err(Error::new(
            Status::GenericFailure,
            format!("napi_create_external_arraybuffer failed: {status}"),
        ));
    }
    let mut ta = std::ptr::null_mut();
    let status = unsafe {
        sys::napi_create_typedarray(
            env.raw(),
            TypedArrayType::Uint32.into(),
            slab.len / 4,
            ab,
            0,
            &mut ta,
        )
    };
    if status != sys::Status::napi_ok {
        return Err(Error::new(
            Status::GenericFailure,
            format!("napi_create_typedarray failed: {status}"),
        ));
    }
    Ok(ta)
}

#[cfg(unix)]
unsafe fn call_js(
    env: sys::napi_env,
    _receiver: sys::napi_value,
    callback: sys::napi_value,
    args: &[sys::napi_value],
) {
    // `napi_make_callback` wants an object receiver; the callbacks never read `this`.
    let mut receiver = std::ptr::null_mut();
    if sys::napi_get_global(env, &mut receiver) != sys::Status::napi_ok {
        return;
    }
    // `napi_make_callback`, not `napi_call_function`: it opens the callback scope that drains the
    // microtask and `process.nextTick` queues when the call returns. Called from a libuv callback with
    // no JS above it, a promise continuation would otherwise wait for the next unrelated wake-up.
    let status = sys::napi_make_callback(
        env,
        std::ptr::null_mut(),
        receiver,
        callback,
        args.len(),
        args.as_ptr(),
        std::ptr::null_mut(),
    );
    if status == sys::Status::napi_pending_exception {
        // There is no JS stack above the libuv callback to receive this exception.
        let mut exception = std::ptr::null_mut();
        if sys::napi_get_and_clear_last_exception(env, &mut exception) == sys::Status::napi_ok {
            let _ = sys::napi_fatal_exception(env, exception);
        }
    }
}

#[cfg(unix)]
unsafe fn call_js_u32(raw_env: sys::napi_env, cb_ref: sys::napi_ref, value: u32) {
    if cb_ref.is_null() {
        return;
    }
    let mut scope = std::ptr::null_mut();
    if sys::napi_open_handle_scope(raw_env, &mut scope) != sys::Status::napi_ok {
        return;
    }
    let mut cb = std::ptr::null_mut();
    let mut arg0 = std::ptr::null_mut();
    if sys::napi_get_reference_value(raw_env, cb_ref, &mut cb) == sys::Status::napi_ok
        && sys::napi_create_uint32(raw_env, value, &mut arg0) == sys::Status::napi_ok
    {
        call_js(raw_env, std::ptr::null_mut(), cb, &[arg0]);
    }
    let _ = sys::napi_close_handle_scope(raw_env, scope);
}

#[cfg(unix)]
unsafe fn call_js_ws_message(
    raw_env: sys::napi_env,
    cb_ref: sys::napi_ref,
    socket_id: u32,
    event: &WsEvent,
) {
    if cb_ref.is_null() {
        return;
    }
    let mut scope = std::ptr::null_mut();
    if sys::napi_open_handle_scope(raw_env, &mut scope) != sys::Status::napi_ok {
        return;
    }
    let mut cb = std::ptr::null_mut();
    let mut undef = std::ptr::null_mut();
    let mut arg0 = std::ptr::null_mut();
    let mut arg1 = std::ptr::null_mut();
    let ok_val = match event {
        WsEvent::Text(text) => {
            sys::napi_create_string_utf8(raw_env, text.as_ptr().cast(), text.len(), &mut arg1)
                == sys::Status::napi_ok
        }
        WsEvent::Binary(bytes) => {
            let mut data_ptr = std::ptr::null_mut();
            if sys::napi_create_arraybuffer(raw_env, bytes.len(), &mut data_ptr, &mut arg1)
                == sys::Status::napi_ok
            {
                if !bytes.is_empty() && !data_ptr.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), data_ptr.cast(), bytes.len());
                }
                true
            } else {
                false
            }
        }
        WsEvent::Close { .. } => false,
    };
    if ok_val
        && sys::napi_get_reference_value(raw_env, cb_ref, &mut cb) == sys::Status::napi_ok
        && sys::napi_get_undefined(raw_env, &mut undef) == sys::Status::napi_ok
        && sys::napi_create_uint32(raw_env, socket_id, &mut arg0) == sys::Status::napi_ok
    {
        let args = [arg0, arg1];
        call_js(raw_env, undef, cb, &args);
    }
    let _ = sys::napi_close_handle_scope(raw_env, scope);
}

#[cfg(unix)]
unsafe fn call_js_ws_close(
    raw_env: sys::napi_env,
    cb_ref: sys::napi_ref,
    socket_id: u32,
    code: u16,
    reason: &str,
) {
    if cb_ref.is_null() {
        return;
    }
    let mut scope = std::ptr::null_mut();
    if sys::napi_open_handle_scope(raw_env, &mut scope) != sys::Status::napi_ok {
        return;
    }
    let mut cb = std::ptr::null_mut();
    let mut undef = std::ptr::null_mut();
    let mut arg0 = std::ptr::null_mut();
    let mut arg1 = std::ptr::null_mut();
    let mut arg2 = std::ptr::null_mut();
    if sys::napi_get_reference_value(raw_env, cb_ref, &mut cb) == sys::Status::napi_ok
        && sys::napi_get_undefined(raw_env, &mut undef) == sys::Status::napi_ok
        && sys::napi_create_uint32(raw_env, socket_id, &mut arg0) == sys::Status::napi_ok
        && sys::napi_create_uint32(raw_env, code as u32, &mut arg1) == sys::Status::napi_ok
        && sys::napi_create_string_utf8(raw_env, reason.as_ptr().cast(), reason.len(), &mut arg2)
            == sys::Status::napi_ok
    {
        let args = [arg0, arg1, arg2];
        call_js(raw_env, undef, cb, &args);
    }
    let _ = sys::napi_close_handle_scope(raw_env, scope);
}

#[napi(object)]
pub struct EngineCapabilities {
    pub http2: bool,
    pub tls_reload: bool,
    pub websocket: bool,
    pub static_routes: bool,
    pub param_routes: bool,
    pub batched_ring: bool,
    pub zero_hop_libuv: bool,
    pub tls: bool,
    pub tls_crl: bool,
    pub tls_policy: bool,
    pub mtls: bool,
    pub ws_per_message_deflate: bool,
    pub response_limits: bool,
    pub idle_spares_draining_response: bool,
    pub env_cleanup_hook: bool,
}

#[napi(object)]
pub struct ProbeResult {
    pub ok: bool,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub transport: String,
    pub capabilities: EngineCapabilities,
}

#[napi]
pub fn probe() -> ProbeResult {
    ProbeResult {
        ok: true,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        transport: detect_transport().as_str().to_owned(),
        capabilities: EngineCapabilities {
            http2: cfg!(unix),
            tls_reload: true,
            websocket: cfg!(unix),
            static_routes: true,
            param_routes: true,
            batched_ring: true,
            zero_hop_libuv: cfg!(unix),
            tls: true,
            tls_crl: true,
            tls_policy: true,
            mtls: true,
            ws_per_message_deflate: cfg!(unix),
            response_limits: true,
            idle_spares_draining_response: cfg!(unix),
            env_cleanup_hook: cfg!(unix),
        },
    }
}

#[napi(object)]
pub struct TlsOptions {
    pub cert: Option<String>,
    pub key: Option<String>,
    pub cert_file_name: Option<String>,
    pub key_file_name: Option<String>,
    pub ca: Option<String>,
    pub ca_file_name: Option<String>,
    pub crl: Option<String>,
    pub crl_file_name: Option<String>,
    pub request_cert: Option<bool>,
    pub reject_unauthorized: Option<bool>,
    pub min_version: Option<String>,
    pub max_version: Option<String>,
    pub ciphers: Option<String>,
    pub ciphersuites: Option<String>,
    pub ecdh_curve: Option<String>,
    pub ticket_keys: Option<Buffer>,
}

#[cfg(unix)]
fn to_tls_input(opts: &TlsOptions, http2_enabled: bool) -> TlsInput {
    let alpn_protocols = if http2_enabled {
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    } else {
        vec![b"http/1.1".to_vec()]
    };
    let request_cert = opts.request_cert.unwrap_or(false);
    TlsInput {
        cert_pem: opts.cert.as_ref().map(|s| s.as_bytes().to_vec()),
        key_pem: opts.key.as_ref().map(|s| s.as_bytes().to_vec()),
        cert_file: opts.cert_file_name.clone(),
        key_file: opts.key_file_name.clone(),
        ca_pem: opts.ca.as_ref().map(|s| s.as_bytes().to_vec()),
        ca_file: opts.ca_file_name.clone(),
        crl_pem: opts.crl.as_ref().map(|s| s.as_bytes().to_vec()),
        crl_file: opts.crl_file_name.clone(),
        request_cert,
        reject_unauthorized: opts.reject_unauthorized.unwrap_or(request_cert),
        min_version: opts.min_version.clone(),
        max_version: opts.max_version.clone(),
        ciphers: opts.ciphers.clone(),
        ciphersuites: opts.ciphersuites.clone(),
        ecdh_curve: opts.ecdh_curve.clone(),
        alpn_protocols,
        ticket_keys: opts.ticket_keys.as_ref().map(|b| b.as_ref().to_vec()),
    }
}

#[napi(object)]
pub struct WsDeflateOptions {
    pub server_no_context_takeover: Option<bool>,
    pub client_no_context_takeover: Option<bool>,
    pub server_max_window_bits: Option<u32>,
    pub client_max_window_bits: Option<u32>,
    pub threshold: Option<u32>,
    pub max_decompressed_size: Option<u32>,
    pub level: Option<u32>,
    pub shared_compressor: Option<bool>,
}

#[napi(object)]
pub struct UvServerOptions {
    pub max_body_size: Option<u32>,
    pub oversize_window: Option<u32>,
    pub max_header_bytes: Option<u32>,
    pub max_headers: Option<u32>,
    pub max_uri_size: Option<u32>,
    pub max_pending_bytes: Option<u32>,
    pub idle_timeout_ms: Option<u32>,
    pub response_timeout_ms: Option<u32>,
    pub response_backpressure_limit: Option<u32>,
    pub backlog: Option<u32>,
    pub max_connections: Option<u32>,
    pub request_timeout_ms: Option<u32>,
    pub headers_timeout_ms: Option<u32>,
    pub ws_max_message_size: Option<u32>,
    pub ws_max_lifetime_ms: Option<u32>,
    pub ws_deflate: Option<WsDeflateOptions>,
    pub http2: Option<bool>,
    pub http2_max_concurrent_streams: Option<u32>,
    pub reuse_port: Option<bool>,
    pub tls: Option<TlsOptions>,
}

#[cfg(unix)]
enum HeadStorage {
    Empty,
    /// Zero-alloc slice into `UvHttpShared::batch_heads` for the duration of the current batch.
    /// Automatically promoted to `Owned` if the request remains in-flight after `onBatch` returns.
    BatchSlice {
        off: u32,
        len: u32,
    },
    Owned(Box<[u8]>),
}

#[cfg(unix)]
impl HeadStorage {
    #[inline]
    fn as_bytes<'a>(&'a self, arena: &'a [u8]) -> &'a [u8] {
        match self {
            Self::Empty => &[],
            Self::BatchSlice { off, len } => {
                let start = *off as usize;
                let end = start + (*len as usize);
                arena.get(start..end).unwrap_or(&[])
            }
            Self::Owned(b) => b,
        }
    }

    fn into_owned(self, arena: &[u8]) -> Box<[u8]> {
        match self {
            Self::Empty => Box::new([]),
            Self::BatchSlice { off, len } => {
                let start = off as usize;
                let end = start + (len as usize);
                arena.get(start..end).unwrap_or(&[]).into()
            }
            Self::Owned(b) => b,
        }
    }
}

#[cfg(unix)]
const PENDING_KEEP_ALIVE: u8 = 1 << 0;
#[cfg(unix)]
const PENDING_STREAMING: u8 = 1 << 1;
#[cfg(unix)]
const PENDING_CHUNKED: u8 = 1 << 2;
#[cfg(unix)]
const PENDING_H2: u8 = 1 << 3;
/// The request was HTTP/1.0, which has no chunked framing to answer with.
#[cfg(unix)]
const PENDING_HTTP10: u8 = 1 << 4;

#[cfg(unix)]
#[derive(Default)]
struct PendingCold {
    parsed_head: OnceCell<Vec<String>>,
    custom_method: Option<Box<str>>,
    h2_stream_id: Option<u32>,
    h2_headers: Option<Vec<(String, String)>>,
    query: Option<Box<str>>,
    body: Option<Vec<u8>>,
}

#[cfg(unix)]
struct PendingReq {
    conn_id: u32,
    prev_on_conn: u32,
    next_on_conn: u32,
    flags: u8,
    raw_head: HeadStorage,
    cold: Option<Box<PendingCold>>,
}

#[cfg(unix)]
impl PendingReq {
    #[inline]
    fn new(
        conn_id: u32,
        keep_alive: bool,
        raw_head: HeadStorage,
        cold: Option<Box<PendingCold>>,
    ) -> Self {
        let mut flags = if keep_alive { PENDING_KEEP_ALIVE } else { 0 };
        if cold.as_ref().is_some_and(|c| c.h2_stream_id.is_some()) {
            flags |= PENDING_H2;
        }
        Self {
            conn_id,
            prev_on_conn: 0,
            next_on_conn: 0,
            flags,
            raw_head,
            cold,
        }
    }

    #[inline]
    fn keep_alive(&self) -> bool {
        (self.flags & PENDING_KEEP_ALIVE) != 0
    }

    /// A streamed HTTP/1.0 response of unknown length ends where the connection does.
    fn close_delimits(&mut self) {
        self.flags &= !PENDING_KEEP_ALIVE;
    }

    #[inline]
    fn streaming(&self) -> bool {
        (self.flags & PENDING_STREAMING) != 0
    }

    #[inline]
    fn set_streaming(&mut self) {
        self.flags |= PENDING_STREAMING;
    }

    #[inline]
    fn chunked(&self) -> bool {
        (self.flags & PENDING_CHUNKED) != 0
    }

    #[inline]
    fn set_chunked(&mut self, chunked: bool) {
        if chunked {
            self.flags |= PENDING_CHUNKED;
        } else {
            self.flags &= !PENDING_CHUNKED;
        }
    }

    #[inline]
    fn h2_stream_id(&self) -> Option<u32> {
        if (self.flags & PENDING_H2) == 0 {
            return None;
        }
        self.cold.as_ref().and_then(|c| c.h2_stream_id)
    }

    #[inline]
    fn h2_headers(&self) -> Option<&Vec<(String, String)>> {
        self.cold.as_ref().and_then(|c| c.h2_headers.as_ref())
    }

    #[inline]
    fn custom_method(&self) -> Option<&str> {
        self.cold.as_ref().and_then(|c| c.custom_method.as_deref())
    }

    #[inline]
    fn body(&self) -> Option<&[u8]> {
        self.cold.as_ref().and_then(|c| c.body.as_deref())
    }

    fn parsed_head(&mut self, arena: &[u8]) -> &[String] {
        let raw = &self.raw_head;
        let cold = self.cold.get_or_insert_with(Default::default);
        cold.parsed_head
            .get_or_init(|| collect_headers_in_head(raw.as_bytes(arena)))
    }
}

/// What joins a repeated field: cookie pairs split on `;` (RFC 9113 section 8.2.3), the rest on `,`.
fn field_separator(name: &str) -> &'static str {
    if name.eq_ignore_ascii_case("cookie") {
        "; "
    } else {
        ", "
    }
}

#[cfg(unix)]
fn header_from_head(fields: &[String], name: &str) -> Option<String> {
    let mut values = fields
        .chunks_exact(2)
        .filter(|pair| pair[0].eq_ignore_ascii_case(name))
        .map(|pair| pair[1].as_str());
    let mut value = values.next()?.to_owned();
    if !name.eq_ignore_ascii_case("content-type") {
        for next in values {
            value.push_str(field_separator(name));
            value.push_str(next);
        }
    }
    Some(value)
}

/// One response that is waiting its turn behind an earlier request on the same connection.
#[cfg(unix)]
#[derive(Default)]
struct Held {
    bytes: Vec<u8>,
    done: bool,
    keep_alive: bool,
}

/// The requests an HTTP/1.1 connection owes responses to, in the order they must be answered.
///
/// A handler can finish out of order (async, or a native route next to a JS one), but a client matches
/// responses to requests by position, so an answer that finishes early waits in `held`.
#[cfg(unix)]
#[derive(Default)]
struct H1Order {
    queue: VecDeque<u32>,
    held: HashMap<u32, Held>,
    held_bytes: usize,
}

/// O(1) direct-indexed per-connection metadata indexed by `nifra_io::conn_slot(conn_id)`.
/// Keeps non-pipelined HTTP/1.1 keep-alive requests completely free of heap allocations and hashing.
#[cfg(unix)]
#[derive(Default)]
struct ConnMetaSlot {
    gen_id: u32,
    pending_head: u32,
    h1_head: u32,
    h1_overflow: Option<Box<H1Order>>,
    chunk_resume: Option<Box<ChunkResume>>,
    ws: Option<Box<WsConnState>>,
    h2: Option<Box<H2Conn>>,
    /// A terminal parse error is queued behind earlier answers: whatever the peer sends next is dropped.
    refuse_input: bool,
    /// The request being received was already looked at for `Expect: 100-continue`.
    continue_checked: bool,
}

#[cfg(unix)]
impl ConnMetaSlot {
    #[inline]
    fn clear_for(&mut self, new_gen_id: u32) {
        self.gen_id = new_gen_id;
        self.pending_head = 0;
        self.h1_head = 0;
        self.h1_overflow = None;
        self.chunk_resume = None;
        self.ws = None;
        self.h2 = None;
        self.refuse_input = false;
        self.continue_checked = false;
    }

    /// An open WebSocket that has not sent its Close.
    fn ws_sendable(&self) -> bool {
        self.ws.as_ref().is_some_and(|ws| !ws.conn.close_sent())
    }

    #[inline]
    fn has_h1_pending(&self) -> bool {
        self.h1_head != 0
            || self
                .h1_overflow
                .as_ref()
                .is_some_and(|o| !o.queue.is_empty())
    }

    #[inline]
    fn h1_len(&self) -> usize {
        if let Some(ref o) = self.h1_overflow {
            o.queue.len()
        } else if self.h1_head != 0 {
            1
        } else {
            0
        }
    }

    #[inline]
    fn push_h1(&mut self, req_id: u32) {
        if let Some(ref mut order) = self.h1_overflow {
            order.queue.push_back(req_id);
        } else if self.h1_head == 0 {
            self.h1_head = req_id;
        } else {
            let mut order = Box::new(H1Order::default());
            order.queue.push_back(self.h1_head);
            order.queue.push_back(req_id);
            self.h1_head = 0;
            self.h1_overflow = Some(order);
        }
    }
}

#[cfg(unix)]
#[derive(Default)]
struct ConnMetaTable {
    slots: Vec<ConnMetaSlot>,
    // A driver can reuse a connection slot before delivering its old disconnect callback.
    retired_pending: HashMap<u32, u32>,
}

#[cfg(unix)]
impl ConnMetaTable {
    fn with_capacity(cap: usize) -> Self {
        Self {
            slots: Vec::with_capacity(cap),
            retired_pending: HashMap::new(),
        }
    }

    #[inline]
    fn ensure(&mut self, conn_id: u32) -> &mut ConnMetaSlot {
        let idx = conn_slot(conn_id);
        if idx >= self.slots.len() {
            self.slots.resize_with(idx + 1, ConnMetaSlot::default);
        }
        let slot = &mut self.slots[idx];
        if slot.gen_id != conn_id {
            if slot.pending_head != 0 {
                self.retired_pending.insert(slot.gen_id, slot.pending_head);
            }
            slot.clear_for(conn_id);
        }
        slot
    }

    #[inline]
    fn get(&self, conn_id: u32) -> Option<&ConnMetaSlot> {
        let slot = self.slots.get(conn_slot(conn_id))?;
        (slot.gen_id == conn_id).then_some(slot)
    }

    #[inline]
    fn get_mut(&mut self, conn_id: u32) -> Option<&mut ConnMetaSlot> {
        let slot = self.slots.get_mut(conn_slot(conn_id))?;
        (slot.gen_id == conn_id).then_some(slot)
    }

    fn pending_head(&self, conn_id: u32) -> u32 {
        match self.get(conn_id) {
            Some(slot) => slot.pending_head,
            None => self.retired_pending.get(&conn_id).copied().unwrap_or(0),
        }
    }

    fn set_pending_head(&mut self, conn_id: u32, head: u32) {
        if let Some(slot) = self.get_mut(conn_id) {
            slot.pending_head = head;
        } else if head == 0 {
            self.retired_pending.remove(&conn_id);
        } else {
            self.retired_pending.insert(conn_id, head);
        }
    }

    fn clear_conn(&mut self, conn_id: u32) -> Option<Box<WsConnState>> {
        let slot = self.slots.get_mut(conn_slot(conn_id))?;
        if slot.gen_id != conn_id {
            return None;
        }
        slot.gen_id = 0;
        slot.pending_head = 0;
        slot.h1_head = 0;
        slot.h1_overflow = None;
        slot.chunk_resume = None;
        slot.h2 = None;
        slot.ws.take()
    }

    fn clear_all(&mut self) {
        self.slots.clear();
        self.retired_pending.clear();
    }
}

/// Most bytes one connection may park behind an unanswered earlier request before it is closed.
#[cfg(unix)]
const MAX_HELD_BYTES: usize = 8 * 1024 * 1024;
/// How long a server-initiated WebSocket close waits for the peer's Close before the socket is cut.
#[cfg(unix)]
const WS_CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Most unanswered pipelined requests one HTTP/1.1 connection may have in flight.
#[cfg(unix)]
const MAX_PIPELINED: usize = 1024;

/// Write to an HTTP/1.1 connection. While the connection is inside `on_data`, `write_to_conn` parks
/// the bytes and appends them after what the handler already queued.
#[cfg(unix)]
#[inline]
fn h1_write(
    server: &UvServer,
    _st: &mut UvHttpShared,
    conn_id: u32,
    bytes: &[u8],
    close: bool,
) -> WriteResult {
    server.write_to_conn(conn_id, bytes, close)
}

/// Send `bytes` of request `req_id`'s HTTP/1.1 response in request order. `finish` marks the response
/// complete; `keep_alive` is the request's own keep-alive. Returns `Closed` once the socket is gone.
#[cfg(unix)]
fn h1_send(
    server: &UvServer,
    st: &mut UvHttpShared,
    conn_id: u32,
    req_id: u32,
    bytes: &[u8],
    finish: bool,
    keep_alive: bool,
) -> WriteResult {
    let mut taken_order = {
        let Some(slot) = st.conn_meta.get_mut(conn_id) else {
            return server.write_to_conn_h1(conn_id, bytes, finish && !keep_alive, finish);
        };
        if let Some(order) = slot.h1_overflow.take() {
            order
        } else if slot.h1_head == req_id {
            if finish {
                slot.h1_head = 0;
                return server.write_to_conn_h1(conn_id, bytes, !keep_alive, true);
            }
            return server.write_to_conn(conn_id, bytes, false);
        } else {
            return server.write_to_conn_h1(conn_id, bytes, finish && !keep_alive, finish);
        }
    };

    let ended = finish && server.has_read_ended(conn_id);
    let result = 'send: {
        if taken_order.queue.front() != Some(&req_id) {
            if !taken_order.queue.contains(&req_id) {
                break 'send h1_write(server, st, conn_id, bytes, finish && (!keep_alive || ended));
            }
            let held = taken_order.held.entry(req_id).or_default();
            held.bytes.extend_from_slice(bytes);
            held.done |= finish;
            held.keep_alive = keep_alive;
            taken_order.held_bytes += bytes.len();
            if finish {
                // The request id returns to the slab now: the queue keeps the answer under its own.
                let own = next_placeholder(st);
                if let Some(held) = taken_order.held.remove(&req_id) {
                    taken_order.held.insert(own, held);
                }
                if let Some(id) = taken_order.queue.iter_mut().find(|id| **id == req_id) {
                    *id = own;
                }
            }
            if taken_order.held_bytes > st.max_held_bytes {
                server.close_conn(conn_id);
                return WriteResult::Closed;
            }
            break 'send WriteResult::Written;
        }
        if finish {
            taken_order.queue.pop_front();
        }
        let close = finish && (!keep_alive || (ended && taken_order.queue.is_empty()));
        let mut result = h1_write(server, st, conn_id, bytes, close);
        if finish && !close {
            // Answers that finished (or started) while this one held the socket go out now.
            while result != WriteResult::Closed {
                let Some(&next) = taken_order.queue.front() else {
                    break;
                };
                let Some(held) = taken_order.held.get_mut(&next) else {
                    break;
                };
                let chunk = std::mem::take(&mut held.bytes);
                taken_order.held_bytes -= chunk.len();
                if !held.done {
                    // It is the head now: what it has so far goes out, the rest streams live.
                    if !chunk.is_empty() {
                        result = h1_write(server, st, conn_id, &chunk, false);
                    }
                    break;
                }
                let keep = held.keep_alive;
                taken_order.held.remove(&next);
                taken_order.queue.pop_front();
                let close = !keep || (ended && taken_order.queue.is_empty());
                result = h1_write(server, st, conn_id, &chunk, close);
                if close {
                    break;
                }
            }
        }
        result
    };
    if result != WriteResult::Closed && !taken_order.queue.is_empty() {
        if let Some(slot) = st.conn_meta.get_mut(conn_id) {
            slot.h1_overflow = Some(taken_order);
        }
    }
    result
}

/// Set on every queued-answer id: slab ids count the requests in flight and never reach it.
#[cfg(unix)]
const PLACEHOLDER_BIT: u32 = 1 << 31;

/// An id for a queued answer that no request owns.
#[cfg(unix)]
fn next_placeholder(st: &mut UvHttpShared) -> u32 {
    st.placeholder_seq = st.placeholder_seq.wrapping_add(1);
    PLACEHOLDER_BIT | st.placeholder_seq
}

/// Queue a finished answer behind the connection's earlier unanswered requests, so it leaves in
/// request order. Returns `true` when more than `MAX_HELD_BYTES` now wait on this connection.
#[cfg(unix)]
fn park_behind_pending(
    st: &mut UvHttpShared,
    conn_id: u32,
    frame: Vec<u8>,
    keep_alive: bool,
) -> bool {
    let id = next_placeholder(st);
    let slot = st.conn_meta.ensure(conn_id);
    if slot.h1_overflow.is_none() {
        let mut order = Box::new(H1Order::default());
        if slot.h1_head != 0 {
            order.queue.push_back(slot.h1_head);
            slot.h1_head = 0;
        }
        slot.h1_overflow = Some(order);
    }
    let Some(order) = slot.h1_overflow.as_deref_mut() else {
        return false;
    };
    order.queue.push_back(id);
    order.held_bytes += frame.len();
    let over = order.held_bytes > st.max_held_bytes;
    order.held.insert(
        id,
        Held {
            bytes: frame,
            done: true,
            keep_alive,
        },
    );
    over
}

/// Answer a request the parser refused and end the connection. A request still being handled on the
/// connection owns the next bytes the client reads, so the error waits its turn behind it.
#[cfg(unix)]
fn refuse_request(
    st: &mut UvHttpShared,
    conn_id: u32,
    template: u32,
    body: &[u8],
    write_buf: &mut Vec<u8>,
    consumed: usize,
) -> ConnAction {
    if st
        .conn_meta
        .get(conn_id)
        .is_some_and(|s| s.has_h1_pending())
    {
        let mut frame = Vec::new();
        st.templates.write_prepared(template, body, &mut frame);
        if park_behind_pending(st, conn_id, frame, false) {
            return ConnAction::CloseNow;
        }
        st.conn_meta.ensure(conn_id).refuse_input = true;
        return ConnAction::Continue { consumed };
    }
    st.templates.write_prepared(template, body, write_buf);
    // What the peer sends from here on is not another request.
    st.conn_meta.ensure(conn_id).refuse_input = true;
    ConnAction::Refuse { consumed }
}

/// Direct-indexed O(1) free-list slab replacing `HashMap<u32, PendingReq>` on the hot path.
#[cfg(unix)]
struct PendingSlab {
    slots: Vec<Option<PendingReq>>,
    free: Vec<u32>,
    active: usize,
}

#[cfg(unix)]
impl PendingSlab {
    fn with_capacity(cap: usize) -> Self {
        Self {
            slots: Vec::with_capacity(cap),
            free: Vec::with_capacity(cap),
            active: 0,
        }
    }

    #[inline]
    fn is_empty(&self) -> bool {
        self.active == 0
    }

    #[inline]
    fn insert(&mut self, conn_meta: &mut ConnMetaTable, mut req: PendingReq) -> u32 {
        let slot = conn_meta.ensure(req.conn_id);
        req.next_on_conn = slot.pending_head;
        self.active += 1;
        let id = if let Some(idx) = self.free.pop() {
            self.slots[idx as usize] = Some(req);
            idx + 1
        } else {
            let idx = self.slots.len() as u32;
            self.slots.push(Some(req));
            idx + 1
        };
        if let Some(previous_head) = self.get_mut(slot.pending_head) {
            previous_head.prev_on_conn = id;
        }
        slot.pending_head = id;
        id
    }

    #[inline]
    fn get(&self, id: u32) -> Option<&PendingReq> {
        if id == 0 {
            return None;
        }
        self.slots.get((id - 1) as usize)?.as_ref()
    }

    #[inline]
    fn get_mut(&mut self, id: u32) -> Option<&mut PendingReq> {
        if id == 0 {
            return None;
        }
        self.slots.get_mut((id - 1) as usize)?.as_mut()
    }

    #[inline]
    fn remove(&mut self, conn_meta: &mut ConnMetaTable, id: u32) -> Option<PendingReq> {
        if id == 0 {
            return None;
        }
        let idx = (id - 1) as usize;
        let slot = self.slots.get_mut(idx)?;
        let val = slot.take()?;
        if let Some(prev) = self.get_mut(val.prev_on_conn) {
            prev.next_on_conn = val.next_on_conn;
        } else {
            conn_meta.set_pending_head(val.conn_id, val.next_on_conn);
        }
        if let Some(next) = self.get_mut(val.next_on_conn) {
            next.prev_on_conn = val.prev_on_conn;
        }
        self.free.push(idx as u32);
        self.active -= 1;
        Some(val)
    }

    fn remove_connection(&mut self, conn_meta: &mut ConnMetaTable, conn_id: u32) -> Vec<u32> {
        let mut ids = Vec::new();
        let mut id = conn_meta.pending_head(conn_id);
        while let Some(req) = self.remove(conn_meta, id) {
            ids.push(id);
            id = req.next_on_conn;
        }
        // Preserve the slab order used to deliver abort notifications.
        ids.sort_unstable();
        ids
    }

    fn iter_connection(&self, mut id: u32) -> impl Iterator<Item = (u32, &PendingReq)> {
        std::iter::from_fn(move || {
            let request = self.get(id)?;
            let entry = (id, request);
            id = request.next_on_conn;
            Some(entry)
        })
    }

    fn iter(&self) -> impl Iterator<Item = (u32, &PendingReq)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| s.as_ref().map(|r| ((i as u32) + 1, r)))
    }

    fn clear(&mut self) {
        self.slots.clear();
        self.free.clear();
        self.active = 0;
    }
}

#[cfg(all(unix, test))]
mod pending_tests {
    use super::*;

    #[test]
    fn disconnect_drains_only_the_retired_generation() {
        let retired = 0x40005;
        let replacement = 0x80005;
        assert_eq!(conn_slot(retired), conn_slot(replacement));
        let mut connections = ConnMetaTable::default();
        let mut pending = PendingSlab::with_capacity(4);
        let request = |conn_id| PendingReq::new(conn_id, true, HeadStorage::Empty, None);

        let first = pending.insert(&mut connections, request(retired));
        let finished = pending.insert(&mut connections, request(retired));
        let last = pending.insert(&mut connections, request(retired));
        assert!(pending.remove(&mut connections, finished).is_some());
        let current = pending.insert(&mut connections, request(replacement));
        assert_eq!(current, finished);
        assert!(connections.get(retired).is_none());

        let aborted = pending.remove_connection(&mut connections, retired);
        connections.clear_conn(retired);
        assert_eq!(aborted, vec![first, last]);
        assert!(pending.get(first).is_none());
        assert!(pending.get(last).is_none());
        assert_eq!(connections.pending_head(retired), 0);
        assert_eq!(connections.pending_head(replacement), current);
        assert_eq!(pending.get(current).unwrap().conn_id, replacement);
        assert_eq!(
            pending.remove_connection(&mut connections, replacement),
            vec![current]
        );
        assert!(pending.is_empty());
    }
}

#[cfg(unix)]
struct WsConnState {
    conn: WsConn,
    /// A Ping from the idle sweep that nothing has been heard since.
    awaiting_pong: std::cell::Cell<bool>,
    raw_head: Box<[u8]>,
    query: String,
    close_emitted: bool,
}

#[cfg(unix)]
struct UvHttpShared {
    raw_env: sys::napi_env,
    on_batch_ref: sys::napi_ref,
    on_writable_ref: sys::napi_ref,
    on_aborted_ref: sys::napi_ref,
    on_ws_open_ref: sys::napi_ref,
    on_ws_message_ref: sys::napi_ref,
    on_ws_close_ref: sys::napi_ref,
    ws_max_message_size: usize,
    ws_deflate_cfg: WsDeflateConfig,
    ws_shared_pool: Option<SharedCompressorPool>,
    http2_enabled: bool,
    h2_cfg: H2Config,
    routes: FastRoutes,
    templates: PreparedTemplates,
    template_meta: Vec<(u16, Vec<(String, String)>)>,
    bad_req_tpl: u32,
    too_large_tpl: u32,
    uri_too_large_tpl: u32,
    headers_too_large_tpl: u32,
    max_held_bytes: usize,
    limits: ParseLimits,
    in_meta: Arc<SharedSlab>,
    in_data: Arc<SharedSlab>,
    out_meta: Arc<SharedSlab>,
    out_data: Arc<SharedSlab>,
    batch_count: usize,
    batch_data_pos: usize,
    batch_heads: Vec<u8>,
    batch_req_ids: Vec<u32>,
    /// Requests (id, connection, stream) whose stream was reset before the batch carrying them
    /// reached JS: their ids stay held until after it, so no later request reuses one in that batch.
    reset_in_batch: Vec<(u32, u32, u32)>,
    pending: PendingSlab,
    conn_meta: ConnMetaTable,
    /// The last id given to a finished answer parked behind an earlier request.
    placeholder_seq: u32,
    scratch_frame: Vec<u8>,
}

#[cfg(unix)]
impl UvHttpShared {
    #[inline]
    fn insert_pending(&mut self, req: PendingReq) -> u32 {
        self.pending.insert(&mut self.conn_meta, req)
    }

    #[inline]
    fn remove_pending(&mut self, req_id: u32) -> Option<PendingReq> {
        self.pending.remove(&mut self.conn_meta, req_id)
    }

    fn disconnect_pending(&mut self, conn_id: u32) -> Vec<u32> {
        self.pending.remove_connection(&mut self.conn_meta, conn_id)
    }
}

#[cfg(unix)]
#[inline]
fn with_flat_header_pairs<R>(hdr_vec: &[String], f: impl FnOnce(&[(&str, &str)]) -> R) -> R {
    let count = hdr_vec.len() / 2;
    if count <= 16 {
        let mut stack = [("", ""); 16];
        for (i, c) in hdr_vec.chunks_exact(2).enumerate() {
            stack[i] = (c[0].as_str(), c[1].as_str());
        }
        f(&stack[..count])
    } else {
        let pairs: Vec<(&str, &str)> = hdr_vec
            .chunks_exact(2)
            .map(|c| (c[0].as_str(), c[1].as_str()))
            .collect();
        f(&pairs)
    }
}

#[cfg(unix)]
#[inline]
fn with_tuple_header_pairs<R>(
    hdrs: &[(String, String)],
    f: impl FnOnce(&[(&str, &str)]) -> R,
) -> R {
    let count = hdrs.len();
    if count <= 16 {
        let mut stack = [("", ""); 16];
        for (i, (k, v)) in hdrs.iter().enumerate() {
            stack[i] = (k.as_str(), v.as_str());
        }
        f(&stack[..count])
    } else {
        let pairs: Vec<(&str, &str)> = hdrs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        f(&pairs)
    }
}

/// Call a registered callback once per id, resolving it each time: a handler may delete it.
#[cfg(unix)]
fn notify_each(
    shared: &Rc<RefCell<UvHttpShared>>,
    ids: Vec<u32>,
    pick: fn(&UvHttpShared) -> sys::napi_ref,
) {
    for id in ids {
        let (raw_env, cb_ref) = {
            let st = shared.borrow();
            (st.raw_env, pick(&st))
        };
        unsafe { call_js_u32(raw_env, cb_ref, id) };
    }
}

#[cfg(unix)]
fn invoke_on_batch_unlocked(shared: &Rc<RefCell<UvHttpShared>>) {
    let (raw_env, on_batch_ref, count) = {
        let mut st = shared.borrow_mut();
        let c = st.batch_count;
        if c == 0 || st.on_batch_ref.is_null() {
            return;
        }
        st.batch_count = 0;
        st.batch_data_pos = 0;
        (st.raw_env, st.on_batch_ref, c)
    };
    unsafe { call_js_u32(raw_env, on_batch_ref, count as u32) };

    // A stream reset while its request was still in that batch is aborted now, once JS has it.
    let resets = {
        let mut st = shared.borrow_mut();
        let resets = std::mem::take(&mut st.reset_in_batch);
        let mut aborted = Vec::with_capacity(resets.len());
        for (id, conn_id, stream_id) in resets {
            let same = st
                .pending
                .get(id)
                .is_some_and(|p| p.conn_id == conn_id && p.h2_stream_id() == Some(stream_id));
            if same {
                st.remove_pending(id);
                aborted.push(id);
            }
        }
        aborted
    };
    notify_each(shared, resets, |st| st.on_aborted_ref);

    // Promote any request that stayed async past `onBatch` out of the per-batch head arena.
    let mut st = shared.borrow_mut();
    let UvHttpShared {
        ref mut pending,
        ref mut batch_heads,
        ref mut batch_req_ids,
        ..
    } = *st;
    if !pending.is_empty() {
        for &req_id in batch_req_ids.iter() {
            if let Some(req) = pending.get_mut(req_id) {
                if let HeadStorage::BatchSlice { off, len } = req.raw_head {
                    let start = off as usize;
                    let end = start + (len as usize);
                    let owned: Box<[u8]> = batch_heads.get(start..end).unwrap_or(&[]).into();
                    req.raw_head = HeadStorage::Owned(owned);
                }
            }
        }
    }
    batch_req_ids.clear();
    batch_heads.clear();
    if batch_heads.capacity() > 256 * 1024 {
        batch_heads.shrink_to(64 * 1024);
    }
}

#[cfg(unix)]
struct HttpUvCallbacks {
    shared: Rc<RefCell<UvHttpShared>>,
}

#[cfg(unix)]
impl HttpUvCallbacks {
    fn on_data_body(
        &mut self,
        conn_id: u32,
        read_buf: &[u8],
        write_buf: &mut Vec<u8>,
    ) -> ConnAction {
        let mut st = self.shared.borrow_mut();

        if st.conn_meta.get(conn_id).is_some_and(|s| s.refuse_input) {
            return ConnAction::Continue {
                consumed: read_buf.len(),
            };
        }

        // If this connection has already upgraded to WebSocket, decode RFC 6455 frames directly.
        if let Some(ws) = st
            .conn_meta
            .get_mut(conn_id)
            .and_then(|s| s.ws.as_deref_mut())
        {
            ws.awaiting_pong.set(false);
            let feed = ws.conn.feed(read_buf, write_buf);
            let has_close = feed
                .events
                .iter()
                .any(|e| matches!(e, WsEvent::Close { .. }));
            if has_close {
                ws.close_emitted = true;
            }
            drop(st);
            for event in &feed.events {
                let (raw_env, msg_ref, close_ref) = {
                    let st = self.shared.borrow();
                    (st.raw_env, st.on_ws_message_ref, st.on_ws_close_ref)
                };
                match event {
                    WsEvent::Text(_) | WsEvent::Binary(_) => unsafe {
                        call_js_ws_message(raw_env, msg_ref, conn_id, event);
                    },
                    WsEvent::Close { code, reason } => unsafe {
                        call_js_ws_close(raw_env, close_ref, conn_id, *code, reason);
                    },
                }
            }
            return if feed.close_after_write {
                ConnAction::CloseAfterWrite {
                    consumed: feed.consumed,
                }
            } else {
                ConnAction::Continue {
                    consumed: feed.consumed,
                }
            };
        }

        // Check HTTP/2 (existing H2 connection or incoming client preface when http2 is enabled).
        let h2_mode = if st.conn_meta.get(conn_id).is_some_and(|s| s.h2.is_some()) {
            1u8 // active H2
        } else if st.http2_enabled {
            if read_buf.starts_with(CLIENT_PREFACE) {
                let cfg = st.h2_cfg;
                st.conn_meta.ensure(conn_id).h2 = Some(Box::new(H2Conn::new(cfg)));
                1u8
            } else if read_buf.len() < CLIENT_PREFACE.len() && CLIENT_PREFACE.starts_with(read_buf)
            {
                2u8 // partial H2 preface, wait for more bytes
            } else {
                0u8
            }
        } else if read_buf.starts_with(b"PRI * HTTP/2.0") {
            3u8 // H2 disabled: refuse H2 preface immediately
        } else {
            0u8
        };
        if h2_mode == 2 {
            return ConnAction::Continue { consumed: 0 };
        }
        if h2_mode == 3 {
            // RFC 9113 section 3.3: a server without prior-knowledge HTTP/2 answers the preface as the
            // HTTP/1.1 request it looks like, with a 505, so the client sees a refusal and not a hang-up.
            write_buffered_response(
                write_buf,
                505,
                &[("content-type", "text/plain"), ("connection", "close")],
                Some(b"HTTP/2 is not enabled"),
            );
            return ConnAction::CloseAfterWrite {
                consumed: read_buf.len(),
            };
        }
        if h2_mode == 1 {
            let Some(h2) = st
                .conn_meta
                .get_mut(conn_id)
                .and_then(|s| s.h2.as_deref_mut())
            else {
                return ConnAction::CloseNow;
            };
            let feed = h2.feed(read_buf, write_buf);
            drop(st);
            for event in feed.events {
                match event {
                    H2Event::Request(req) => {
                        let inline_body = req.body.len() <= nifra_http::abi::INLINE_BODY_MAX;
                        let ct_len = h2_content_type(&req).map_or(0, str::len);
                        let needed = req.path.len()
                            + req.query.len()
                            + ct_len
                            + if inline_body { req.body.len() } else { 0 };
                        if !has_batch_room(&self.shared.borrow(), needed) {
                            invoke_on_batch_unlocked(&self.shared);
                        }
                        let mut st = self.shared.borrow_mut();
                        let stream_id = req.stream_id;
                        if !pack_h2_into_shared(&mut st, conn_id, req) {
                            if let Some(conn) = st
                                .conn_meta
                                .get_mut(conn_id)
                                .and_then(|s| s.h2.as_deref_mut())
                            {
                                // INTERNAL_ERROR: this request did not fit the bridge's batch.
                                conn.reset_stream(stream_id, 0x2, write_buf);
                            }
                        }
                    }
                    H2Event::StreamReset(stream_id) => {
                        let aborted = {
                            let mut st = self.shared.borrow_mut();
                            let ids: Vec<u32> = st
                                .pending
                                .iter()
                                .filter(|(_, p)| {
                                    p.conn_id == conn_id && p.h2_stream_id() == Some(stream_id)
                                })
                                .map(|(id, _)| id)
                                .collect();
                            let mut aborted = Vec::with_capacity(ids.len());
                            for id in ids {
                                if st.batch_req_ids.contains(&id) {
                                    st.reset_in_batch.push((id, conn_id, stream_id));
                                } else {
                                    st.remove_pending(id);
                                    aborted.push(id);
                                }
                            }
                            aborted
                        };
                        notify_each(&self.shared, aborted, |st| st.on_aborted_ref);
                    }
                    H2Event::GoAway => {}
                }
            }
            // Streams whose response backlog drained after a WINDOW_UPDATE may write again.
            for stream_id in feed.writable {
                let ids: Vec<u32> = {
                    let st = self.shared.borrow();
                    st.pending
                        .iter()
                        .filter(|(_, p)| {
                            p.conn_id == conn_id
                                && p.h2_stream_id() == Some(stream_id)
                                && p.streaming()
                        })
                        .map(|(id, _)| id)
                        .collect()
                };
                notify_each(&self.shared, ids, |st| st.on_writable_ref);
            }
            return if feed.close_after_write {
                ConnAction::CloseAfterWrite {
                    consumed: feed.consumed,
                }
            } else {
                ConnAction::Continue {
                    consumed: feed.consumed,
                }
            };
        }

        let mut consumed = 0usize;
        let mut close_after = false;
        let limits = st.limits;
        let mut resume = st
            .conn_meta
            .get_mut(conn_id)
            .and_then(|s| s.chunk_resume.take())
            .map_or_else(ChunkResume::default, |b| *b);

        loop {
            if consumed >= read_buf.len() {
                break;
            }
            match parse_http1_resume(&read_buf[consumed..], limits, &mut resume) {
                Ok(ParseStatus::Complete(req)) => {
                    if let Some(slot) = st.conn_meta.get_mut(conn_id) {
                        slot.continue_checked = false;
                    }
                    let req_head = &read_buf[consumed..consumed + req.head_len];
                    consumed += req.total_bytes;

                    // 1) Try native fast-path routes (zero JS crossing). One that finds an earlier
                    // request still unanswered waits behind it instead of jumping the queue.
                    let mut parked = false;
                    let mut over_held = false;
                    let fast_hit = if st.routes.is_empty()
                        || req.method_idx != 0
                        || req.is_ws_upgrade
                        || req.over_max_body
                    {
                        false
                    } else if st
                        .conn_meta
                        .get(conn_id)
                        .is_some_and(|s| s.has_h1_pending())
                    {
                        let mut frame = Vec::new();
                        if st.routes.try_match_get(req.path, &mut frame) {
                            over_held =
                                park_behind_pending(&mut st, conn_id, frame, req.keep_alive);
                            parked = true;
                            true
                        } else {
                            false
                        }
                    } else {
                        st.routes.try_match_get(req.path, write_buf)
                    };
                    if over_held {
                        return ConnAction::CloseNow;
                    }
                    if fast_hit {
                        if resume.is_active() {
                            resume = ChunkResume::default();
                        }
                        if !req.keep_alive {
                            st.conn_meta.ensure(conn_id).refuse_input = true;
                            close_after = !parked;
                            break;
                        }
                        continue;
                    }

                    let body_slice = req.body.as_ref();
                    let inline_body = body_slice.len() <= nifra_http::abi::INLINE_BODY_MAX;
                    let needed = req.path.len()
                        + req.query.len()
                        + req.content_type.map_or(0, <[u8]>::len)
                        + if inline_body { body_slice.len() } else { 0 };
                    if !has_batch_room(&st, needed) {
                        drop(st);
                        invoke_on_batch_unlocked(&self.shared);
                        st = self.shared.borrow_mut();
                    }

                    // Inline bodies live directly in `inData` (zero heap alloc); only spill > 64 KiB.
                    let saved_body = if inline_body || body_slice.is_empty() {
                        None
                    } else {
                        Some(body_slice.to_vec())
                    };
                    let saved_query = if req.is_ws_upgrade && !req.query.is_empty() {
                        Some(req.query.into())
                    } else {
                        None
                    };
                    let custom_method = if req.method_idx >= 7 {
                        Some(req.method.into())
                    } else {
                        None
                    };
                    let cold =
                        if saved_body.is_some() || saved_query.is_some() || custom_method.is_some()
                        {
                            Some(Box::new(PendingCold {
                                parsed_head: OnceCell::new(),
                                custom_method,
                                h2_stream_id: None,
                                h2_headers: None,
                                query: saved_query,
                                body: saved_body,
                            }))
                        } else {
                            None
                        };

                    // 2) Pack into zero-copy `inMeta` + `inData` and bump-allocate raw_head in `batch_heads`.
                    if st
                        .conn_meta
                        .get(conn_id)
                        .is_some_and(|s| s.h1_len() >= MAX_PIPELINED)
                    {
                        // A client that stacks this many unanswered requests is not reading.
                        return ConnAction::CloseNow;
                    }
                    let head_off = st.batch_heads.len() as u32;
                    st.batch_heads.extend_from_slice(req_head);
                    let raw_head = HeadStorage::BatchSlice {
                        off: head_off,
                        len: req_head.len() as u32,
                    };
                    let mut pending = PendingReq::new(conn_id, req.keep_alive, raw_head, cold);
                    if req.http10 {
                        pending.flags |= PENDING_HTTP10;
                    }
                    let req_id = st.insert_pending(pending);
                    if pack_into_shared(&mut st, req_id, &req) {
                        st.batch_req_ids.push(req_id);
                        st.conn_meta.ensure(conn_id).push_h1(req_id);
                    } else {
                        st.remove_pending(req_id);
                        st.batch_heads.truncate(head_off as usize);
                        let template = st.headers_too_large_tpl;
                        return refuse_request(
                            &mut st,
                            conn_id,
                            template,
                            b"Request Header Fields Too Large",
                            write_buf,
                            read_buf.len(),
                        );
                    }

                    if resume.is_active() {
                        resume = ChunkResume::default();
                    }
                    if !req.keep_alive {
                        st.conn_meta.ensure(conn_id).refuse_input = true;
                        break;
                    }
                }
                Ok(ParseStatus::Incomplete) => {
                    if resume.is_active() {
                        st.conn_meta.ensure(conn_id).chunk_resume = Some(Box::new(resume));
                    }
                    let slot = st.conn_meta.ensure(conn_id);
                    if !slot.continue_checked {
                        if let Some(expects) = awaits_continue(&read_buf[consumed..]) {
                            slot.continue_checked = true;
                            if expects {
                                const CONTINUE: &[u8] = b"HTTP/1.1 100 Continue\r\n\r\n";
                                // Behind an earlier request still unanswered, it queues like a reply.
                                if !slot.has_h1_pending() {
                                    write_buf.extend_from_slice(CONTINUE);
                                } else if park_behind_pending(
                                    &mut st,
                                    conn_id,
                                    CONTINUE.to_vec(),
                                    true,
                                ) {
                                    return ConnAction::CloseNow;
                                }
                            }
                        }
                    }
                    break;
                }
                Err(nifra_http::ParseError::PayloadTooLarge) => {
                    let template = st.too_large_tpl;
                    return refuse_request(
                        &mut st,
                        conn_id,
                        template,
                        b"",
                        write_buf,
                        read_buf.len(),
                    );
                }
                Err(nifra_http::ParseError::UriTooLarge) => {
                    let template = st.uri_too_large_tpl;
                    return refuse_request(
                        &mut st,
                        conn_id,
                        template,
                        b"URI Too Long",
                        write_buf,
                        read_buf.len(),
                    );
                }
                Err(nifra_http::ParseError::HeadersTooLarge) => {
                    let template = st.headers_too_large_tpl;
                    return refuse_request(
                        &mut st,
                        conn_id,
                        template,
                        b"Request Header Fields Too Large",
                        write_buf,
                        read_buf.len(),
                    );
                }
                Err(_) => {
                    let template = st.bad_req_tpl;
                    return refuse_request(
                        &mut st,
                        conn_id,
                        template,
                        b"Bad Request",
                        write_buf,
                        read_buf.len(),
                    );
                }
            }
        }

        if close_after {
            ConnAction::CloseAfterWrite { consumed }
        } else {
            ConnAction::Continue { consumed }
        }
    }
}

#[cfg(unix)]
impl UvCallbacks for HttpUvCallbacks {
    fn on_data(&mut self, conn_id: u32, read_buf: &[u8], write_buf: &mut Vec<u8>) -> ConnAction {
        self.on_data_body(conn_id, read_buf, write_buf)
    }

    fn on_turn_end(&mut self) {
        invoke_on_batch_unlocked(&self.shared);
    }

    fn expire_requests(
        &mut self,
        conn_id: u32,
        now: std::time::Instant,
        out: &mut Vec<u8>,
    ) -> bool {
        self.shared
            .borrow_mut()
            .conn_meta
            .get_mut(conn_id)
            .and_then(|slot| slot.h2.as_deref_mut())
            .is_some_and(|h2| h2.expire_requests(now, out))
    }

    fn oldest_incomplete_head(&self, conn_id: u32) -> Option<std::time::Instant> {
        self.shared
            .borrow()
            .conn_meta
            .get(conn_id)
            .and_then(|s| s.h2.as_deref())
            .and_then(H2Conn::oldest_incomplete_head)
    }

    fn reads_http1(&self, conn_id: u32) -> bool {
        !self
            .shared
            .borrow()
            .conn_meta
            .get(conn_id)
            .is_some_and(|s| s.ws.is_some() || s.h2.is_some())
    }

    fn output_stalled_since(&self, conn_id: u32) -> Option<std::time::Instant> {
        self.shared
            .borrow()
            .conn_meta
            .get(conn_id)
            .and_then(|s| s.h2.as_deref())
            .and_then(H2Conn::output_stalled_since)
    }

    fn probe_idle(&self, conn_id: u32) -> bool {
        self.shared
            .borrow()
            .conn_meta
            .get(conn_id)
            .and_then(|s| s.ws.as_deref())
            .is_some_and(|ws| !ws.conn.close_sent() && !ws.awaiting_pong.replace(true))
    }

    fn unanswered_only(&self, conn_id: u32) -> bool {
        let st = self.shared.borrow();
        let mut any = false;
        for (_, request) in st.pending.iter() {
            if request.conn_id != conn_id {
                continue;
            }
            if request.streaming() {
                return false;
            }
            any = true;
        }
        any && !st.conn_meta.get(conn_id).is_some_and(|s| s.h2.is_some())
    }

    fn has_pending_requests(&self, conn_id: u32) -> bool {
        let st = self.shared.borrow();
        st.conn_meta.get(conn_id).is_some_and(|s| {
            s.pending_head != 0
                || s.has_h1_pending()
                || s.h2
                    .as_ref()
                    .is_some_and(|conn| conn.active_response_streams() > 0)
        })
    }

    fn is_websocket(&self, conn_id: u32) -> bool {
        self.shared
            .borrow()
            .conn_meta
            .get(conn_id)
            .is_some_and(|s| s.ws.is_some())
    }

    fn without_pending(&self, ids: Vec<u32>) -> Vec<u32> {
        let st = self.shared.borrow();
        ids.into_iter()
            .filter(|&id| {
                !st.conn_meta.get(id).is_some_and(|s| {
                    s.pending_head != 0
                        || s.has_h1_pending()
                        || s.h2
                            .as_ref()
                            .is_some_and(|conn| conn.active_response_streams() > 0)
                })
            })
            .collect()
    }

    fn on_writable(&mut self, conn_id: u32) {
        let mut req_ids: Vec<u32> = {
            let st = self.shared.borrow();
            if st.on_writable_ref.is_null() {
                return;
            }
            st.pending
                .iter_connection(st.conn_meta.pending_head(conn_id))
                .filter(|(_, p)| p.streaming())
                .map(|(id, _)| id)
                .collect()
        };
        req_ids.sort_unstable();
        notify_each(&self.shared, req_ids, |st| st.on_writable_ref);
    }

    fn on_disconnect(&mut self, conn_id: u32) {
        let (aborted_ids, ws_close) = {
            let mut st = self.shared.borrow_mut();
            let ids = st.disconnect_pending(conn_id);
            let ws_close = st.conn_meta.clear_conn(conn_id).and_then(|ws| {
                if ws.close_emitted {
                    None
                } else {
                    // No Close came back, whatever this side had sent (RFC 6455 section 7.1.5).
                    Some((1006, String::new()))
                }
            });
            (ids, ws_close)
        };
        notify_each(&self.shared, aborted_ids, |st| st.on_aborted_ref);
        if let Some((code, reason)) = ws_close {
            // Read after those calls: a handler may have stopped the server and dropped it.
            let (raw_env, ws_close_ref) = {
                let st = self.shared.borrow();
                (st.raw_env, st.on_ws_close_ref)
            };
            unsafe { call_js_ws_close(raw_env, ws_close_ref, conn_id, code, &reason) };
        }
    }
}

#[cfg(unix)]
#[inline]
fn has_batch_room(st: &UvHttpShared, needed_data: usize) -> bool {
    let slot_base = st.batch_count * IN_SLOT_U32S;
    let max_u32s = st.in_meta.len / 4;
    slot_base + IN_SLOT_U32S <= max_u32s && st.batch_data_pos + needed_data <= st.in_data.len
}

#[cfg(unix)]
fn pack_into_shared(
    st: &mut UvHttpShared,
    req_id: u32,
    req: &nifra_http::ParsedRequest<'_>,
) -> bool {
    let slot_base = st.batch_count * IN_SLOT_U32S;
    let max_u32s = st.in_meta.len / 4;
    if slot_base + IN_SLOT_U32S > max_u32s {
        return false;
    }
    let path_bytes = req.path.as_bytes();
    let query_bytes = req.query.as_bytes();
    let body_slice = req.body.as_ref();
    let inline_body = body_slice.len() <= nifra_http::abi::INLINE_BODY_MAX;
    let ct_bytes = req.content_type.unwrap_or_default();
    let needed = path_bytes.len()
        + query_bytes.len()
        + ct_bytes.len()
        + if inline_body { body_slice.len() } else { 0 };
    if st.batch_data_pos + needed > st.in_data.len {
        return false;
    }

    let data = unsafe { st.in_data.as_bytes_mut() };
    let meta = unsafe { st.in_meta.as_u32_mut() };

    let path_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + path_bytes.len()].copy_from_slice(path_bytes);
    st.batch_data_pos += path_bytes.len();

    let query_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + query_bytes.len()].copy_from_slice(query_bytes);
    st.batch_data_pos += query_bytes.len();

    let ct_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + ct_bytes.len()].copy_from_slice(ct_bytes);
    st.batch_data_pos += ct_bytes.len();

    let (body_off, body_len) = if inline_body {
        let off = st.batch_data_pos as u32;
        data[st.batch_data_pos..st.batch_data_pos + body_slice.len()].copy_from_slice(body_slice);
        st.batch_data_pos += body_slice.len();
        (off, body_slice.len() as u32)
    } else {
        (
            nifra_http::abi::LARGE_BODY_SENTINEL,
            body_slice.len() as u32,
        )
    };

    let mut flags = (req.method_idx as u32) & nifra_http::abi::METHOD_MASK;
    if !body_slice.is_empty() {
        flags |= nifra_http::abi::FLAG_HAS_BODY;
        if body_slice.is_ascii() {
            flags |= nifra_http::abi::FLAG_IS_ASCII_BODY;
        }
    }
    if req.is_ws_upgrade {
        flags |= nifra_http::abi::FLAG_IS_WS_UPGRADE;
    }
    if req.host_valid {
        flags |= nifra_http::abi::FLAG_HOST_VALID;
    }
    if req.over_max_body {
        flags |= nifra_http::abi::FLAG_OVER_MAX_BODY;
    }
    if !inline_body {
        flags |= nifra_http::abi::FLAG_LARGE_BODY;
    }
    if req.is_json_ct {
        flags |= nifra_http::abi::FLAG_CT_JSON;
    }
    if req.content_type.is_some() {
        flags |= nifra_http::abi::FLAG_HAS_CT;
    }
    if req.is_chunked {
        flags |= nifra_http::abi::FLAG_CHUNKED;
    }

    meta[slot_base] = req_id;
    meta[slot_base + 1] = flags;
    meta[slot_base + 2] = path_off;
    meta[slot_base + 3] = path_bytes.len() as u32;
    meta[slot_base + 4] = query_off;
    meta[slot_base + 5] = query_bytes.len() as u32;
    meta[slot_base + 6] = body_off;
    meta[slot_base + 7] = body_len;
    meta[slot_base + 8] = ct_off;
    meta[slot_base + 9] = ct_bytes.len() as u32;

    st.batch_count += 1;
    true
}

/// The first `content-type` of an HTTP/2 request, as the header lookup would return it.
#[cfg(unix)]
fn h2_content_type(req: &H2Request) -> Option<&str> {
    req.headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, value)| value.as_str())
}

#[cfg(unix)]
fn pack_h2_into_shared(st: &mut UvHttpShared, conn_id: u32, req: H2Request) -> bool {
    let slot_base = st.batch_count * IN_SLOT_U32S;
    let max_u32s = st.in_meta.len / 4;
    if slot_base + IN_SLOT_U32S > max_u32s {
        return false;
    }
    let path_bytes = req.path.as_bytes();
    let query_bytes = req.query.as_bytes();
    let body_slice = req.body.as_slice();
    let inline_body = body_slice.len() <= nifra_http::abi::INLINE_BODY_MAX;
    let content_type = h2_content_type(&req);
    // Header values were widened from latin-1, and the batch carries the bytes as sent.
    let ct_bytes: Vec<u8> =
        content_type.map_or_else(Vec::new, |v| v.chars().map(|c| c as u8).collect());
    let ct_len = ct_bytes.len();
    let needed = path_bytes.len()
        + query_bytes.len()
        + ct_len
        + if inline_body { body_slice.len() } else { 0 };
    if st.batch_data_pos + needed > st.in_data.len {
        return false;
    }

    let data = unsafe { st.in_data.as_bytes_mut() };

    let path_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + path_bytes.len()].copy_from_slice(path_bytes);
    st.batch_data_pos += path_bytes.len();

    let query_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + query_bytes.len()].copy_from_slice(query_bytes);
    st.batch_data_pos += query_bytes.len();

    let ct_off = st.batch_data_pos as u32;
    data[st.batch_data_pos..st.batch_data_pos + ct_bytes.len()].copy_from_slice(&ct_bytes);
    st.batch_data_pos += ct_bytes.len();

    let (body_off, body_len) = if inline_body {
        let off = st.batch_data_pos as u32;
        data[st.batch_data_pos..st.batch_data_pos + body_slice.len()].copy_from_slice(body_slice);
        st.batch_data_pos += body_slice.len();
        (off, body_slice.len() as u32)
    } else {
        (
            nifra_http::abi::LARGE_BODY_SENTINEL,
            body_slice.len() as u32,
        )
    };

    let mut flags =
        ((req.method_idx as u32) & nifra_http::abi::METHOD_MASK) | nifra_http::abi::FLAG_IS_H2;
    if !body_slice.is_empty() {
        flags |= nifra_http::abi::FLAG_HAS_BODY;
        if body_slice.is_ascii() {
            flags |= nifra_http::abi::FLAG_IS_ASCII_BODY;
        }
    }
    if req.host_valid {
        flags |= nifra_http::abi::FLAG_HOST_VALID;
    }
    if req.over_max_body {
        flags |= nifra_http::abi::FLAG_OVER_MAX_BODY;
    }
    if !inline_body {
        flags |= nifra_http::abi::FLAG_LARGE_BODY;
    }
    if req.is_json_ct {
        flags |= nifra_http::abi::FLAG_CT_JSON;
    }
    if content_type.is_some() {
        flags |= nifra_http::abi::FLAG_HAS_CT;
    }

    let cold = Box::new(PendingCold {
        parsed_head: OnceCell::new(),
        custom_method: (req.method_idx >= 7).then(|| req.method.into_boxed_str()),
        h2_stream_id: Some(req.stream_id),
        h2_headers: Some(req.headers),
        query: None,
        body: (!inline_body).then_some(req.body),
    });
    let req_id = st.insert_pending(PendingReq::new(
        conn_id,
        true,
        HeadStorage::Empty,
        Some(cold),
    ));
    let meta = unsafe { st.in_meta.as_u32_mut() };
    meta[slot_base] = req_id;
    meta[slot_base + 1] = flags;
    meta[slot_base + 2] = path_off;
    meta[slot_base + 3] = path_bytes.len() as u32;
    meta[slot_base + 4] = query_off;
    meta[slot_base + 5] = query_bytes.len() as u32;
    meta[slot_base + 6] = body_off;
    meta[slot_base + 7] = body_len;
    meta[slot_base + 8] = ct_off;
    meta[slot_base + 9] = ct_len as u32;
    st.batch_req_ids.push(req_id);
    st.batch_count += 1;
    true
}

/// Zero-hop HTTP/1.1 + HTTP/2 + WebSocket server running directly on Node.js's main `libuv` event loop.
#[cfg(unix)]
struct EnvCleanupContext {
    server: UvServer,
    shared: Rc<RefCell<UvHttpShared>>,
    closed: Rc<Cell<bool>>,
    cleanup_slot: Rc<Cell<*mut EnvCleanupContext>>,
}

#[cfg(unix)]
fn shutdown_uv_server(server: &UvServer, shared: &Rc<RefCell<UvHttpShared>>, closed: &Cell<bool>) {
    if closed.get() {
        return;
    }
    closed.set(true);
    server.close_all();
    let mut st = shared.borrow_mut();
    let raw_env = st.raw_env;
    let refs = [
        std::mem::replace(&mut st.on_batch_ref, std::ptr::null_mut()),
        std::mem::replace(&mut st.on_writable_ref, std::ptr::null_mut()),
        std::mem::replace(&mut st.on_aborted_ref, std::ptr::null_mut()),
        std::mem::replace(&mut st.on_ws_open_ref, std::ptr::null_mut()),
        std::mem::replace(&mut st.on_ws_message_ref, std::ptr::null_mut()),
        std::mem::replace(&mut st.on_ws_close_ref, std::ptr::null_mut()),
    ];
    for r in refs {
        if !r.is_null() {
            unsafe {
                let _ = sys::napi_delete_reference(raw_env, r);
            }
        }
    }
    st.pending.clear();
    st.conn_meta.clear_all();
}

#[cfg(unix)]
unsafe extern "C" fn on_env_cleanup(arg: *mut c_void) {
    if arg.is_null() {
        return;
    }
    let ctx = Box::from_raw(arg as *mut EnvCleanupContext);
    ctx.cleanup_slot.set(std::ptr::null_mut());
    shutdown_uv_server(&ctx.server, &ctx.shared, &ctx.closed);
}

#[cfg(unix)]
#[napi]
pub struct UvHttpServer {
    port: u16,
    server: UvServer,
    shared: Rc<RefCell<UvHttpShared>>,
    closed: Rc<Cell<bool>>,
    cleanup_raw_env: sys::napi_env,
    cleanup_slot: Rc<Cell<*mut EnvCleanupContext>>,
}

#[cfg(unix)]
#[napi]
impl UvHttpServer {
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port as u32
    }

    /// Register optional `onWritable(reqId)` and `onAborted(reqId)` streaming callbacks.
    #[napi]
    pub fn set_stream_callbacks(
        &self,
        env: Env,
        on_writable: Option<JsFunction>,
        on_aborted: Option<JsFunction>,
    ) -> Result<()> {
        let mut st = self.shared.borrow_mut();
        if !st.on_writable_ref.is_null() {
            unsafe {
                let _ = sys::napi_delete_reference(st.raw_env, st.on_writable_ref);
            }
            st.on_writable_ref = std::ptr::null_mut();
        }
        if !st.on_aborted_ref.is_null() {
            unsafe {
                let _ = sys::napi_delete_reference(st.raw_env, st.on_aborted_ref);
            }
            st.on_aborted_ref = std::ptr::null_mut();
        }
        if let Some(cb) = on_writable {
            let mut r = std::ptr::null_mut();
            let status = unsafe { sys::napi_create_reference(env.raw(), cb.raw(), 1, &mut r) };
            if status != sys::Status::napi_ok {
                return Err(Error::new(
                    Status::GenericFailure,
                    "failed to ref onWritable",
                ));
            }
            st.on_writable_ref = r;
        }
        if let Some(cb) = on_aborted {
            let mut r = std::ptr::null_mut();
            let status = unsafe { sys::napi_create_reference(env.raw(), cb.raw(), 1, &mut r) };
            if status != sys::Status::napi_ok {
                return Err(Error::new(
                    Status::GenericFailure,
                    "failed to ref onAborted",
                ));
            }
            st.on_aborted_ref = r;
        }
        Ok(())
    }

    /// Return zero-copy JS views (`Uint32Array` & `Buffer`) backed directly by Rust's ring slabs.
    #[napi]
    pub fn get_batch_buffers(&self, env: Env) -> Result<Object> {
        let st = self.shared.borrow();
        let mut obj = env.create_object()?;
        let in_meta = external_u32_array(&env, &st.in_meta)?;
        let in_data = external_buffer(&env, &st.in_data)?;
        let out_meta = external_u32_array(&env, &st.out_meta)?;
        let out_data = external_buffer(&env, &st.out_data)?;
        unsafe {
            obj.set_named_property("inMeta", Unknown::from_napi_value(env.raw(), in_meta)?)?;
            obj.set_named_property("inData", Unknown::from_napi_value(env.raw(), in_data)?)?;
            obj.set_named_property("outMeta", Unknown::from_napi_value(env.raw(), out_meta)?)?;
            obj.set_named_property("outData", Unknown::from_napi_value(env.raw(), out_data)?)?;
        }
        obj.set_named_property("inSlotU32s", IN_SLOT_U32S as u32)?;
        obj.set_named_property("outSlotU32s", OUT_SLOT_U32S as u32)?;
        Ok(obj)
    }

    /// Return the raw HTTP method string for non-standard verbs (`methodIdx >= 7`, e.g. `PROPFIND`).
    #[napi]
    pub fn get_method(&self, req_id: u32) -> Option<String> {
        self.shared
            .borrow()
            .pending
            .get(req_id)?
            .custom_method()
            .map(str::to_owned)
    }

    /// Lazily look up a single header by case-insensitive name for an in-flight request.
    #[napi]
    pub fn get_header(&self, req_id: u32, name: String) -> Option<String> {
        let mut st = self.shared.borrow_mut();
        let UvHttpShared {
            ref mut pending,
            ref batch_heads,
            ..
        } = *st;
        let pending = pending.get_mut(req_id)?;
        if let Some(h2_hdrs) = pending.h2_headers() {
            let first_only = name.eq_ignore_ascii_case("content-type");
            let mut found: Option<String> = None;
            for (k, v) in h2_hdrs {
                if k.eq_ignore_ascii_case(&name) {
                    match &mut found {
                        None => {
                            if first_only {
                                return Some(v.clone());
                            }
                            found = Some(v.clone());
                        }
                        Some(existing) => {
                            existing.push_str(field_separator(&name));
                            existing.push_str(v);
                        }
                    }
                }
            }
            return found;
        }
        header_from_head(pending.parsed_head(batch_heads), &name)
    }

    /// Lazily return all request headers as `[lowercaseName, value, ...]`.
    #[napi]
    pub fn get_headers(&self, req_id: u32) -> Vec<String> {
        let mut st = self.shared.borrow_mut();
        let UvHttpShared {
            ref mut pending,
            ref batch_heads,
            ..
        } = *st;
        let Some(pending) = pending.get_mut(req_id) else {
            return Vec::new();
        };
        if let Some(h2_hdrs) = pending.h2_headers() {
            let mut out = Vec::with_capacity(h2_hdrs.len() * 2);
            for (k, v) in h2_hdrs {
                out.push(k.clone());
                out.push(v.clone());
            }
            return out;
        }
        pending.parsed_head(batch_heads).to_vec()
    }

    /// Lazily return the complete request body (used for bodies > 64 KiB or chunked uploads).
    #[napi]
    pub fn get_body(&self, req_id: u32) -> Option<Buffer> {
        let st = self.shared.borrow();
        let pending = st.pending.get(req_id)?;
        pending.body().map(Buffer::from)
    }

    /// Lazily return the socket peer IP address for an in-flight request.
    #[napi]
    pub fn get_remote_address(&self, req_id: u32) -> Option<String> {
        let conn_id = self.shared.borrow().pending.get(req_id)?.conn_id;
        let ip = self.server.remote_addr(conn_id)?;
        if ip.is_empty() {
            None
        } else {
            Some(ip)
        }
    }

    #[napi]
    pub fn set_static_route(
        &self,
        path: String,
        status: u16,
        flat_headers: Vec<String>,
        body: Buffer,
    ) {
        let pairs: Vec<(&str, &str)> = flat_headers
            .chunks_exact(2)
            .map(|c| (c[0].as_str(), c[1].as_str()))
            .collect();
        self.shared
            .borrow_mut()
            .routes
            .add_static_get(path, status, &pairs, body.as_ref());
    }

    #[napi]
    pub fn set_param_route(
        &self,
        prefix: String,
        suffix: String,
        status: u16,
        flat_headers: Vec<String>,
    ) {
        let pairs: Vec<(&str, &str)> = flat_headers
            .chunks_exact(2)
            .map(|c| (c[0].as_str(), c[1].as_str()))
            .collect();
        self.shared
            .borrow_mut()
            .routes
            .add_param_get(prefix, suffix, status, &pairs);
    }

    #[napi]
    pub fn prepare_response(&self, status: u16, flat_headers: Vec<String>) -> u32 {
        let pairs: Vec<(&str, &str)> = flat_headers
            .chunks_exact(2)
            .map(|c| (c[0].as_str(), c[1].as_str()))
            .collect();
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|&(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let mut st = self.shared.borrow_mut();
        let id = st.templates.register(status, &pairs);
        if st.template_meta.len() <= id as usize {
            st.template_meta
                .resize_with(id as usize + 1, || (200, Vec::new()));
        }
        st.template_meta[id as usize] = (status, owned);
        id
    }

    /// Flush `count` synchronous responses written by JS into `outMeta` + `outData`.
    #[napi]
    pub fn flush_responses(&self, count: u32) {
        let mut st = self.shared.borrow_mut();
        let out_meta = Arc::clone(&st.out_meta);
        let out_data = Arc::clone(&st.out_data);
        let meta = unsafe { out_meta.as_u32() };
        let data = unsafe { out_data.as_bytes() };
        let n = (count as usize).min(meta.len() / OUT_SLOT_U32S);
        let (sec, date_text) = nifra_http::date::now_cached();
        let mut frame = std::mem::take(&mut st.scratch_frame);
        for i in 0..n {
            let base = i * OUT_SLOT_U32S;
            let req_id = meta[base];
            let template_id = meta[base + 1];
            let body_off = meta[base + 2] as usize;
            let body_len = meta[base + 3] as usize;
            // Non-zero: that many bytes of header lines precede the body, and the template field
            // carries the status instead.
            let block_len = meta[base + 4] as usize;
            let Some(pending) = st.remove_pending(req_id) else {
                continue;
            };
            let split = body_off + block_len;
            if split + body_len > data.len() {
                continue;
            }
            let body_slice = &data[split..split + body_len];
            frame.clear();
            if block_len != 0 {
                let block = &data[body_off..split];
                let status = template_id as u16;
                if let Some(stream_id) = pending.h2_stream_id() {
                    let Some(h2) = st
                        .conn_meta
                        .get_mut(pending.conn_id)
                        .and_then(|s| s.h2.as_deref_mut())
                    else {
                        continue;
                    };
                    // A validated name holds no ':' and a value no CR or LF, so this splits exactly.
                    let pairs: Vec<(&str, &str)> = std::str::from_utf8(block)
                        .unwrap_or("")
                        .split_terminator("\r\n")
                        .filter_map(|line| line.split_once(": "))
                        .collect();
                    h2.write_response(stream_id, status, &pairs, Some(body_slice), &mut frame);
                    let _ = self.server.write_to_conn(pending.conn_id, &frame, false);
                } else {
                    write_block_response(&mut frame, status, block, body_slice);
                    let _ = h1_send(
                        &self.server,
                        &mut st,
                        pending.conn_id,
                        req_id,
                        &frame,
                        true,
                        pending.keep_alive(),
                    );
                }
                continue;
            }
            if let Some(stream_id) = pending.h2_stream_id() {
                let UvHttpShared {
                    ref template_meta,
                    ref mut conn_meta,
                    ..
                } = *st;
                if let (Some((status, hdrs)), Some(h2)) = (
                    template_meta.get(template_id as usize),
                    conn_meta
                        .get_mut(pending.conn_id)
                        .and_then(|s| s.h2.as_deref_mut()),
                ) {
                    with_tuple_header_pairs(hdrs, |pairs| {
                        h2.write_response(stream_id, *status, pairs, Some(body_slice), &mut frame);
                    });
                    let _ = self.server.write_to_conn(pending.conn_id, &frame, false);
                }
            } else if st.templates.write_prepared_at(
                template_id,
                sec,
                &date_text,
                body_slice,
                &mut frame,
            ) {
                let _ = h1_send(
                    &self.server,
                    &mut st,
                    pending.conn_id,
                    req_id,
                    &frame,
                    true,
                    pending.keep_alive(),
                );
            }
        }
        st.scratch_frame = frame;
    }

    /// Respond to a single request using a prepared template.
    #[napi]
    pub fn respond_prepared(&self, req_id: u32, template_id: u32, body: Buffer) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.remove_pending(req_id) else {
            return false;
        };
        let mut frame = std::mem::take(&mut st.scratch_frame);
        frame.clear();
        if let Some(stream_id) = pending.h2_stream_id() {
            let UvHttpShared {
                ref template_meta,
                ref mut conn_meta,
                ..
            } = *st;
            let (Some((status, hdrs)), Some(h2)) = (
                template_meta.get(template_id as usize),
                conn_meta
                    .get_mut(pending.conn_id)
                    .and_then(|s| s.h2.as_deref_mut()),
            ) else {
                st.scratch_frame = frame;
                return false;
            };
            with_tuple_header_pairs(hdrs, |pairs| {
                h2.write_response(stream_id, *status, pairs, Some(body.as_ref()), &mut frame);
            });
            let sent =
                self.server.write_to_conn(pending.conn_id, &frame, false) != WriteResult::Closed;
            st.scratch_frame = frame;
            return sent;
        }
        let (sec, date_text) = nifra_http::date::now_cached();
        let written =
            st.templates
                .write_prepared_at(template_id, sec, &date_text, body.as_ref(), &mut frame);
        let sent = written
            && h1_send(
                &self.server,
                &mut st,
                pending.conn_id,
                req_id,
                &frame,
                true,
                pending.keep_alive(),
            ) != WriteResult::Closed;
        st.scratch_frame = frame;
        sent
    }

    /// Respond with arbitrary status, flat headers (`[name, value, ...]`), and optional body.
    #[napi]
    pub fn respond(
        &self,
        req_id: u32,
        status: u16,
        flat_headers: Option<Vec<String>>,
        body: Option<Buffer>,
    ) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.remove_pending(req_id) else {
            return false;
        };
        let hdr_vec = flat_headers.unwrap_or_default();
        let mut frame = std::mem::take(&mut st.scratch_frame);
        frame.clear();
        if let Some(stream_id) = pending.h2_stream_id() {
            let Some(h2) = st
                .conn_meta
                .get_mut(pending.conn_id)
                .and_then(|s| s.h2.as_deref_mut())
            else {
                st.scratch_frame = frame;
                return false;
            };
            with_flat_header_pairs(&hdr_vec, |pairs| {
                h2.write_response(
                    stream_id,
                    status,
                    pairs,
                    body.as_ref().map(|b| b.as_ref()),
                    &mut frame,
                );
            });
            let sent =
                self.server.write_to_conn(pending.conn_id, &frame, false) != WriteResult::Closed;
            st.scratch_frame = frame;
            return sent;
        }
        with_flat_header_pairs(&hdr_vec, |pairs| {
            write_buffered_response(&mut frame, status, pairs, body.as_ref().map(|b| b.as_ref()));
        });
        let sent = h1_send(
            &self.server,
            &mut st,
            pending.conn_id,
            req_id,
            &frame,
            true,
            pending.keep_alive(),
        ) != WriteResult::Closed;
        st.scratch_frame = frame;
        sent
    }

    /// Begin a streamed response (`Transfer-Encoding: chunked` unless `contentLength` is passed).
    #[napi]
    pub fn write_head(
        &self,
        req_id: u32,
        status: u16,
        flat_headers: Option<Vec<String>>,
        content_length: Option<u32>,
    ) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.pending.get_mut(req_id) else {
            return false;
        };
        let conn_id = pending.conn_id;
        let h2_stream_id = pending.h2_stream_id();
        let keep_alive = pending.keep_alive();
        let close_delimited = h2_stream_id.is_none()
            && content_length.is_none()
            && (pending.flags & PENDING_HTTP10) != 0;
        if close_delimited {
            pending.close_delimits();
        }
        let keep_alive = keep_alive && !close_delimited;
        pending.set_streaming();
        pending.set_chunked(content_length.is_none() && !close_delimited);

        let hdr_vec = flat_headers.unwrap_or_default();
        let mut frame = std::mem::take(&mut st.scratch_frame);
        frame.clear();
        if let Some(stream_id) = h2_stream_id {
            let Some(h2) = st
                .conn_meta
                .get_mut(conn_id)
                .and_then(|s| s.h2.as_deref_mut())
            else {
                st.scratch_frame = frame;
                return false;
            };
            with_flat_header_pairs(&hdr_vec, |pairs| {
                h2.write_stream_head(
                    stream_id,
                    status,
                    pairs,
                    content_length.map(|n| n as u64),
                    &mut frame,
                );
            });
            let sent = self.server.write_to_conn(conn_id, &frame, false) != WriteResult::Closed;
            st.scratch_frame = frame;
            return sent;
        }
        with_flat_header_pairs(&hdr_vec, |pairs| {
            if close_delimited {
                write_close_delimited_head(&mut frame, status, pairs);
            } else {
                write_stream_head(&mut frame, status, pairs, content_length.map(|n| n as u64));
            }
        });
        let sent = h1_send(
            &self.server,
            &mut st,
            conn_id,
            req_id,
            &frame,
            false,
            keep_alive,
        ) != WriteResult::Closed;
        st.scratch_frame = frame;
        sent
    }

    /// Write a streaming body chunk. Returns `false` if socket send buffer is backpressured
    /// (caller should wait for `onWritable(reqId)`).
    #[napi]
    pub fn write(&self, req_id: u32, chunk: Buffer) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.pending.get(req_id) else {
            return false;
        };
        let conn_id = pending.conn_id;
        let chunked = pending.chunked();
        let keep_alive = pending.keep_alive();
        let h2_stream_id = pending.h2_stream_id();
        if let Some(stream_id) = h2_stream_id {
            let UvHttpShared {
                ref mut conn_meta,
                ref mut scratch_frame,
                ..
            } = *st;
            let Some(h2) = conn_meta.get_mut(conn_id).and_then(|s| s.h2.as_deref_mut()) else {
                return false;
            };
            scratch_frame.clear();
            let room = h2.write_stream_data(stream_id, chunk.as_ref(), false, scratch_frame);
            return self.server.write_to_conn(conn_id, scratch_frame, false)
                == WriteResult::Written
                && room;
        }
        let res = if chunked {
            let mut frame = std::mem::take(&mut st.scratch_frame);
            frame.clear();
            write_chunk(&mut frame, chunk.as_ref());
            let res = h1_send(
                &self.server,
                &mut st,
                conn_id,
                req_id,
                &frame,
                false,
                keep_alive,
            );
            st.scratch_frame = frame;
            res
        } else {
            h1_send(
                &self.server,
                &mut st,
                conn_id,
                req_id,
                chunk.as_ref(),
                false,
                keep_alive,
            )
        };
        res == WriteResult::Written
    }

    /// Finish a streamed response, optionally writing a final chunk and the `0\r\n\r\n` terminator.
    #[napi]
    pub fn end(&self, req_id: u32, chunk: Option<Buffer>) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.remove_pending(req_id) else {
            return false;
        };
        let mut frame = std::mem::take(&mut st.scratch_frame);
        frame.clear();
        if let Some(stream_id) = pending.h2_stream_id() {
            let Some(h2) = st
                .conn_meta
                .get_mut(pending.conn_id)
                .and_then(|s| s.h2.as_deref_mut())
            else {
                st.scratch_frame = frame;
                return false;
            };
            let bytes = chunk.as_ref().map_or(&[][..], |c| c.as_ref());
            h2.write_stream_data(stream_id, bytes, true, &mut frame);
            let sent =
                self.server.write_to_conn(pending.conn_id, &frame, false) != WriteResult::Closed;
            st.scratch_frame = frame;
            return sent;
        }
        if let Some(c) = chunk {
            if pending.chunked() {
                write_chunk(&mut frame, c.as_ref());
            } else {
                frame.extend_from_slice(c.as_ref());
            }
        }
        if pending.chunked() {
            write_chunk_terminator(&mut frame);
        }
        let sent = h1_send(
            &self.server,
            &mut st,
            pending.conn_id,
            req_id,
            &frame,
            true,
            pending.keep_alive(),
        ) != WriteResult::Closed;
        st.scratch_frame = frame;
        sent
    }

    /// Cut an in-progress streamed response immediately: sends `RST_STREAM(INTERNAL_ERROR)` on
    /// HTTP/2 (leaving sibling streams untouched) or closes the TCP socket on HTTP/1.1.
    #[napi]
    pub fn abort_stream(&self, req_id: u32) -> bool {
        let mut st = self.shared.borrow_mut();
        let Some(pending) = st.remove_pending(req_id) else {
            return false;
        };
        if let Some(stream_id) = pending.h2_stream_id() {
            let UvHttpShared {
                ref mut conn_meta,
                ref mut scratch_frame,
                ..
            } = *st;
            if let Some(h2) = conn_meta
                .get_mut(pending.conn_id)
                .and_then(|s| s.h2.as_deref_mut())
            {
                scratch_frame.clear();
                h2.reset_stream(stream_id, ERR_INTERNAL_ERROR, scratch_frame);
                return self
                    .server
                    .write_to_conn(pending.conn_id, scratch_frame, false)
                    != WriteResult::Closed;
            }
            return false;
        }
        self.server.close_conn(pending.conn_id)
    }

    /// Register optional WebSocket callbacks: `onWsOpen(id)`, `onWsMessage(id, data)`, `onWsClose(id, code, reason)`.
    #[napi]
    pub fn set_ws_callbacks(
        &self,
        env: Env,
        on_open: Option<JsFunction>,
        on_message: Option<JsFunction>,
        on_close: Option<JsFunction>,
    ) -> Result<()> {
        let mut st = self.shared.borrow_mut();
        let raw_env = st.raw_env;
        let old_refs = [
            std::mem::replace(&mut st.on_ws_open_ref, std::ptr::null_mut()),
            std::mem::replace(&mut st.on_ws_message_ref, std::ptr::null_mut()),
            std::mem::replace(&mut st.on_ws_close_ref, std::ptr::null_mut()),
        ];
        for r in old_refs {
            if !r.is_null() {
                unsafe {
                    let _ = sys::napi_delete_reference(raw_env, r);
                }
            }
        }
        if let Some(cb) = on_open {
            let mut r = std::ptr::null_mut();
            if unsafe { sys::napi_create_reference(env.raw(), cb.raw(), 1, &mut r) }
                != sys::Status::napi_ok
            {
                return Err(Error::new(Status::GenericFailure, "failed to ref onWsOpen"));
            }
            st.on_ws_open_ref = r;
        }
        if let Some(cb) = on_message {
            let mut r = std::ptr::null_mut();
            if unsafe { sys::napi_create_reference(env.raw(), cb.raw(), 1, &mut r) }
                != sys::Status::napi_ok
            {
                return Err(Error::new(
                    Status::GenericFailure,
                    "failed to ref onWsMessage",
                ));
            }
            st.on_ws_message_ref = r;
        }
        if let Some(cb) = on_close {
            let mut r = std::ptr::null_mut();
            if unsafe { sys::napi_create_reference(env.raw(), cb.raw(), 1, &mut r) }
                != sys::Status::napi_ok
            {
                return Err(Error::new(
                    Status::GenericFailure,
                    "failed to ref onWsClose",
                ));
            }
            st.on_ws_close_ref = r;
        }
        Ok(())
    }

    /// Upgrade an in-flight HTTP/1.1 request to RFC 6455 WebSocket.
    /// Returns the positive socket id (firing `onWsOpen` synchronously), or `-1` if the handshake is invalid.
    #[napi]
    pub fn upgrade_to_web_socket(&self, req_id: u32) -> i32 {
        let (accept, negotiated_deflate) = {
            let mut st = self.shared.borrow_mut();
            let UvHttpShared {
                ref mut pending,
                ref batch_heads,
                ws_deflate_cfg,
                ..
            } = *st;
            let Some(pending) = pending.get_mut(req_id) else {
                return -1;
            };
            let head = pending.parsed_head(batch_heads);
            let conn_hdr = header_from_head(head, "connection");
            let upg_hdr = header_from_head(head, "upgrade");
            let ver_hdr = header_from_head(head, "sec-websocket-version");
            let key_hdr = header_from_head(head, "sec-websocket-key");
            let Some(key) = validate_upgrade_headers(
                conn_hdr.as_deref(),
                upg_hdr.as_deref(),
                ver_hdr.as_deref(),
                key_hdr.as_deref(),
            ) else {
                return -1;
            };
            let ext_hdr = header_from_head(head, "sec-websocket-extensions");
            let negotiated = negotiate_permessage_deflate(ext_hdr.as_deref(), ws_deflate_cfg);
            (compute_accept_key(key), negotiated)
        };

        let (raw_env, open_ref, conn_id) = {
            let mut st = self.shared.borrow_mut();
            // A response still owed to an earlier request would arrive inside the WebSocket stream
            // once 101 is sent ahead of it: the upgrade is refused (answered in order by the caller).
            let owed_earlier = st.pending.get(req_id).is_some_and(|p| {
                st.conn_meta.get(p.conn_id).is_some_and(|slot| {
                    (slot.h1_head != 0 && slot.h1_head != req_id)
                        || slot
                            .h1_overflow
                            .as_ref()
                            .is_some_and(|o| o.queue.iter().any(|&queued| queued != req_id))
                })
            });
            if owed_earlier {
                return -1;
            }
            let Some(mut pending) = st.remove_pending(req_id) else {
                return -1;
            };
            let owned_head = pending.raw_head.into_owned(&st.batch_heads);
            // The connection speaks WebSocket from here on; no HTTP response is owed in order.
            if let Some(slot) = st.conn_meta.get_mut(pending.conn_id) {
                slot.h1_head = 0;
                slot.h1_overflow = None;
            }
            st.scratch_frame.clear();
            write_upgrade_response_with_extensions(
                &accept,
                negotiated_deflate.as_ref().map(|n| n.header_value.as_str()),
                &mut st.scratch_frame,
            );
            if self
                .server
                .write_to_conn(pending.conn_id, &st.scratch_frame, false)
                == WriteResult::Closed
            {
                return -1;
            }
            let max_msg = st.ws_max_message_size;
            let query = pending
                .cold
                .as_mut()
                .and_then(|c| c.query.take())
                .map(String::from)
                .unwrap_or_default();
            st.conn_meta.ensure(pending.conn_id).ws = Some(Box::new(WsConnState {
                conn: WsConn::with_deflate(max_msg, negotiated_deflate.as_ref()),
                awaiting_pong: Default::default(),
                raw_head: owned_head,
                query,
                close_emitted: false,
            }));
            (st.raw_env, st.on_ws_open_ref, pending.conn_id)
        };

        unsafe { call_js_u32(raw_env, open_ref, conn_id) };
        conn_id as i32
    }

    /// Send a binary or text WebSocket frame from a `Buffer`.
    #[napi]
    pub fn ws_send(&self, socket_id: u32, payload: Buffer, is_binary: bool) -> bool {
        send_ws_frame(
            &self.server,
            &self.shared,
            socket_id,
            if is_binary {
                OPCODE_BINARY
            } else {
                OPCODE_TEXT
            },
            payload.as_ref(),
        )
    }

    /// Send a UTF-8 text WebSocket frame directly from a JS `string`.
    #[napi]
    pub fn ws_send_text(&self, socket_id: u32, text: String) -> bool {
        send_ws_frame(
            &self.server,
            &self.shared,
            socket_id,
            OPCODE_TEXT,
            text.as_bytes(),
        )
    }

    /// Send an RFC 6455 Close frame and close the WebSocket connection.
    #[napi]
    pub fn ws_close(&self, socket_id: u32, code: u16, reason: Option<String>) -> bool {
        let reason_str = reason.unwrap_or_default();
        let immediate_close = {
            let mut st = self.shared.borrow_mut();
            let Some(ws) = st
                .conn_meta
                .get_mut(socket_id)
                .and_then(|s| s.ws.as_deref_mut())
            else {
                return false;
            };
            ws.conn.mark_close_sent();
            st.scratch_frame.clear();
            write_close_frame(code, &reason_str, &mut st.scratch_frame);
            // The socket stays open for the peer's own Close (RFC 6455 section 7.1.2); closing at
            // once could reset the connection over the frame just sent. A silent peer is cut off.
            let res = self
                .server
                .write_to_conn(socket_id, &st.scratch_frame, false);
            if res != WriteResult::Closed {
                self.server.close_within(socket_id, WS_CLOSE_WAIT);
            }
            if res == WriteResult::Closed {
                let emit = st
                    .conn_meta
                    .get_mut(socket_id)
                    .and_then(|s| s.ws.take())
                    .is_some_and(|w| !w.close_emitted);
                if emit {
                    Some((st.raw_env, st.on_ws_close_ref))
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some((raw_env, close_ref)) = immediate_close {
            unsafe { call_js_ws_close(raw_env, close_ref, socket_id, code, &reason_str) };
        }
        true
    }

    #[napi]
    pub fn ws_get_headers(&self, socket_id: u32) -> Vec<String> {
        let st = self.shared.borrow();
        let Some(ws) = st.conn_meta.get(socket_id).and_then(|s| s.ws.as_deref()) else {
            return Vec::new();
        };
        collect_headers_in_head(&ws.raw_head)
    }

    #[napi]
    pub fn ws_get_query(&self, socket_id: u32) -> String {
        self.shared
            .borrow()
            .conn_meta
            .get(socket_id)
            .and_then(|s| s.ws.as_deref())
            .map(|ws| ws.query.clone())
            .unwrap_or_default()
    }

    #[napi]
    pub fn ws_get_remote_address(&self, socket_id: u32) -> Option<String> {
        if !self
            .shared
            .borrow()
            .conn_meta
            .get(socket_id)
            .is_some_and(|s| s.ws.is_some())
        {
            return None;
        }
        let ip = self.server.remote_addr(socket_id)?;
        if ip.is_empty() {
            None
        } else {
            Some(ip)
        }
    }

    /// Atomically replace the TLS certificate/key for all new handshakes (preserving session tickets).
    #[napi]
    pub fn reload_tls(&self, tls: TlsOptions) -> Result<()> {
        let http2_enabled = self.shared.borrow().http2_enabled;
        self.server
            .reload_tls(&to_tls_input(&tls, http2_enabled))
            .map_err(|e| Error::new(Status::InvalidArg, e.to_string()))
    }

    /// Whether response bytes are still held for a client: queued on a socket the peer is not
    /// reading, or behind an HTTP/2 flow-control window. A graceful stop waits for this to clear.
    #[napi]
    pub fn has_unsent_output(&self) -> bool {
        if self.server.any_queued() {
            return true;
        }
        let st = self.shared.borrow();
        st.conn_meta.slots.iter().any(|s| {
            s.h2.as_ref()
                .is_some_and(|h| h.active_response_streams() > 0)
        })
    }

    #[napi]
    pub fn stop_listening(&self) {
        self.server.stop_listening();
        // Send HTTP/2 GOAWAY(NO_ERROR) so open H2 sessions finish in-flight streams and close.
        let mut st = self.shared.borrow_mut();
        let UvHttpShared {
            ref mut conn_meta,
            ref mut scratch_frame,
            ..
        } = *st;
        let conn_ids: Vec<u32> = conn_meta
            .slots
            .iter()
            .filter_map(|s| (s.gen_id != 0 && s.h2.is_some()).then_some(s.gen_id))
            .collect();
        for cid in conn_ids {
            if let Some(h2) = conn_meta.get_mut(cid).and_then(|s| s.h2.as_deref_mut()) {
                scratch_frame.clear();
                h2.send_goaway(ERR_NO_ERROR, scratch_frame);
                let close_now = h2.active_response_streams() == 0;
                let _ = self.server.write_to_conn(cid, scratch_frame, close_now);
            }
        }
    }

    #[napi]
    pub fn close(&mut self) {
        let hook = self.cleanup_slot.replace(std::ptr::null_mut());
        if !hook.is_null() {
            unsafe {
                let status = sys::napi_remove_env_cleanup_hook(
                    self.cleanup_raw_env,
                    Some(on_env_cleanup),
                    hook.cast(),
                );
                if status == sys::Status::napi_ok {
                    drop(Box::from_raw(hook));
                }
            }
        }
        shutdown_uv_server(&self.server, &self.shared, &self.closed);
    }
}

#[cfg(unix)]
fn send_ws_frame(
    server: &UvServer,
    shared: &Rc<RefCell<UvHttpShared>>,
    socket_id: u32,
    opcode: u8,
    bytes: &[u8],
) -> bool {
    let mut st = shared.borrow_mut();
    let UvHttpShared {
        ref mut conn_meta,
        ref mut ws_shared_pool,
        ref mut scratch_frame,
        ..
    } = *st;
    let Some(ws) = conn_meta
        .get_mut(socket_id)
        .filter(|s| s.ws_sendable())
        .and_then(|s| s.ws.as_deref_mut())
    else {
        return false;
    };
    let shared_comp = ws
        .conn
        .deflate_server_window_bits()
        .and_then(|bits| ws_shared_pool.as_mut().map(|pool| pool.get_mut(bits)));
    scratch_frame.clear();
    ws.conn
        .encode_server_message(opcode, bytes, shared_comp, scratch_frame);
    server.write_to_conn(socket_id, scratch_frame, false) != WriteResult::Closed
}

#[cfg(unix)]
impl Drop for UvHttpServer {
    fn drop(&mut self) {
        self.close();
    }
}

/// Start a zero-hop HTTP/1.1 + HTTP/2 + WebSocket server directly on Node's `libuv` event loop.
#[cfg(unix)]
#[napi]
pub fn create_uv_server(
    env: Env,
    host: String,
    port: u16,
    on_batch: JsFunction,
    options: Option<UvServerOptions>,
) -> Result<UvHttpServer> {
    let mut uv_loop: *mut sys::uv_loop_s = std::ptr::null_mut();
    let status = unsafe { sys::napi_get_uv_event_loop(env.raw(), &mut uv_loop) };
    if status != sys::Status::napi_ok || uv_loop.is_null() {
        return Err(Error::new(
            Status::GenericFailure,
            format!("napi_get_uv_event_loop failed: {status}"),
        ));
    }

    let mut limits = ParseLimits::default();
    let mut ws_max_message_size = WsConfig::default().max_message_size;
    let mut ws_deflate_cfg = WsDeflateConfig::default();
    let mut max_held_bytes = MAX_HELD_BYTES;
    let mut http2_enabled = false;
    let mut h2_cfg = H2Config::default();
    let mut sock_cfg = SocketConfig::default();
    let mut tls_store: Option<Arc<TlsStore>> = None;
    if let Some(opts) = options {
        if let Some(v) = opts.max_body_size {
            limits.max_body_size = v as usize;
            h2_cfg.max_body_size = v as usize;
        }
        if let Some(v) = opts.oversize_window {
            limits.oversize_window = v as usize;
            h2_cfg.oversize_window = v as usize;
        }
        if let Some(v) = opts.max_header_bytes {
            limits.max_header_bytes = v as usize;
            h2_cfg.max_header_list_size = v as usize;
        }
        if let Some(v) = opts.max_headers {
            limits.max_headers = (v as usize).max(1);
            h2_cfg.max_headers = (v as usize).max(1);
        }
        if let Some(v) = opts.max_uri_size {
            limits.max_uri_size = v as usize;
            h2_cfg.max_uri_size = v as usize;
        }
        if let Some(v) = opts.max_pending_bytes {
            if v > 0 {
                max_held_bytes = v as usize;
            }
        }
        if let Some(v) = opts.idle_timeout_ms {
            sock_cfg.idle_timeout_ms = v as u64;
        }
        if let Some(v) = opts.response_timeout_ms {
            sock_cfg.response_timeout_ms = Some(v as u64);
        }
        if let Some(v) = opts.response_backpressure_limit {
            if v > 0 {
                sock_cfg.max_write_buf_bytes = v as usize;
            }
        }
        if let Some(v) = opts.backlog {
            if v > 0 {
                sock_cfg.backlog = (v as i32).max(1);
            }
        }
        if let Some(v) = opts.max_connections {
            sock_cfg.max_connections = v as usize;
        }
        if let Some(v) = opts.request_timeout_ms {
            sock_cfg.request_timeout_ms = v as u64;
        }
        if let Some(v) = opts.headers_timeout_ms {
            sock_cfg.headers_timeout_ms = v as u64;
        }
        if let Some(v) = opts.ws_max_message_size {
            ws_max_message_size = v as usize;
        }
        if let Some(v) = opts.ws_max_lifetime_ms {
            sock_cfg.ws_max_lifetime_ms = v as u64;
        }
        if let Some(def) = opts.ws_deflate {
            ws_deflate_cfg.enabled = true;
            if let Some(v) = def.server_no_context_takeover {
                ws_deflate_cfg.server_no_context_takeover = v;
            }
            if let Some(v) = def.client_no_context_takeover {
                ws_deflate_cfg.client_no_context_takeover = v;
            }
            if let Some(v) = def.server_max_window_bits {
                if !(9..=15).contains(&v) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        "wsDeflate.serverMaxWindowBits must be an integer 9..15",
                    ));
                }
                ws_deflate_cfg.server_max_window_bits = v as u8;
            }
            if let Some(v) = def.client_max_window_bits {
                ws_deflate_cfg.client_max_window_bits = (v as u8).clamp(8, 15);
            }
            if let Some(v) = def.threshold {
                ws_deflate_cfg.threshold = v as usize;
            }
            if let Some(v) = def.max_decompressed_size {
                ws_deflate_cfg.max_decompressed_size = v as usize;
            }
            if let Some(v) = def.level {
                ws_deflate_cfg.level = (v as u8).clamp(1, 9);
            }
            if let Some(v) = def.shared_compressor {
                ws_deflate_cfg.shared_compressor = v;
            }
        }
        if let Some(h2) = opts.http2 {
            http2_enabled = h2;
        }
        if let Some(mcs) = opts.http2_max_concurrent_streams {
            h2_cfg.max_concurrent_streams = mcs.max(1);
        }
        if let Some(rp) = opts.reuse_port {
            sock_cfg.reuse_port = rp;
        }
        if let Some(ref tls_opts) = opts.tls {
            let store = TlsStore::from_input(&to_tls_input(tls_opts, http2_enabled))
                .map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
            tls_store = Some(Arc::new(store));
        }
    }

    h2_cfg.request_timeout = (sock_cfg.request_timeout_ms > 0)
        .then(|| std::time::Duration::from_millis(sock_cfg.request_timeout_ms));

    let ws_shared_pool = (ws_deflate_cfg.enabled && ws_deflate_cfg.shared_compressor).then(|| {
        let mut pool = SharedCompressorPool::new(ws_deflate_cfg.level);
        let _ = pool.get_mut(ws_deflate_cfg.server_max_window_bits);
        pool
    });

    let (listener, local_addr) = bind_tcp_listener(&host, port, sock_cfg)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;

    // Taken only once the options are valid and the port is bound, so a failed start holds no callback.
    let mut cb_ref: sys::napi_ref = std::ptr::null_mut();
    let status = unsafe { sys::napi_create_reference(env.raw(), on_batch.raw(), 1, &mut cb_ref) };
    if status != sys::Status::napi_ok {
        return Err(Error::new(
            Status::GenericFailure,
            format!("napi_create_reference failed: {status}"),
        ));
    }

    let mut templates = PreparedTemplates::default();
    let bad_req_tpl = templates.register(400, &[("content-type", "text/plain; charset=utf-8")]);
    let too_large_tpl = templates.register(413, &[]);
    let uri_too_large_tpl =
        templates.register(414, &[("content-type", "text/plain; charset=utf-8")]);
    let headers_too_large_tpl =
        templates.register(431, &[("content-type", "text/plain; charset=utf-8")]);
    let template_meta = vec![
        (
            400,
            vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        ),
        (413, vec![]),
        (
            414,
            vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        ),
        (
            431,
            vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        ),
    ];

    let shared = Rc::new(RefCell::new(UvHttpShared {
        raw_env: env.raw(),
        on_batch_ref: cb_ref,
        on_writable_ref: std::ptr::null_mut(),
        on_aborted_ref: std::ptr::null_mut(),
        on_ws_open_ref: std::ptr::null_mut(),
        on_ws_message_ref: std::ptr::null_mut(),
        on_ws_close_ref: std::ptr::null_mut(),
        ws_max_message_size,
        ws_deflate_cfg,
        ws_shared_pool,
        http2_enabled,
        h2_cfg,
        routes: FastRoutes::default(),
        templates,
        template_meta,
        bad_req_tpl,
        too_large_tpl,
        uri_too_large_tpl,
        headers_too_large_tpl,
        max_held_bytes,
        limits,
        in_meta: SharedSlab::new(DEFAULT_IN_SLOTS * IN_SLOT_U32S * 4, 16),
        in_data: SharedSlab::new(DEFAULT_IN_DATA_BYTES, 16),
        out_meta: SharedSlab::new(DEFAULT_OUT_SLOTS * OUT_SLOT_U32S * 4, 16),
        out_data: SharedSlab::new(DEFAULT_OUT_DATA_BYTES, 16),
        batch_count: 0,
        batch_data_pos: 0,
        batch_heads: Vec::with_capacity(64 * 1024),
        batch_req_ids: Vec::with_capacity(DEFAULT_IN_SLOTS),
        reset_in_batch: Vec::new(),
        pending: PendingSlab::with_capacity(256),
        conn_meta: ConnMetaTable::with_capacity(256),
        placeholder_seq: 0,
        scratch_frame: Vec::with_capacity(4096),
    }));

    let callbacks = Box::new(HttpUvCallbacks {
        shared: Rc::clone(&shared),
    });

    // SAFETY: `uv_loop` came from `napi_get_uv_event_loop` for this thread's environment just above.
    let server = unsafe {
        UvServer::start_with_tls(uv_loop.cast(), listener, sock_cfg, tls_store, callbacks)
    }
    .map_err(|e| {
        unsafe { sys::napi_delete_reference(env.raw(), cb_ref) };
        Error::new(Status::GenericFailure, e.to_string())
    })?;

    let closed = Rc::new(Cell::new(false));
    let cleanup_slot = Rc::new(Cell::new(std::ptr::null_mut()));
    let ctx_ptr = Box::into_raw(Box::new(EnvCleanupContext {
        server: server.clone(),
        shared: Rc::clone(&shared),
        closed: Rc::clone(&closed),
        cleanup_slot: Rc::clone(&cleanup_slot),
    }));
    let hook_status =
        unsafe { sys::napi_add_env_cleanup_hook(env.raw(), Some(on_env_cleanup), ctx_ptr.cast()) };
    if hook_status == sys::Status::napi_ok {
        cleanup_slot.set(ctx_ptr);
    } else {
        unsafe { drop(Box::from_raw(ctx_ptr)) };
    }

    Ok(UvHttpServer {
        port: local_addr.port(),
        server,
        shared,
        closed,
        cleanup_raw_env: env.raw(),
        cleanup_slot,
    })
}

#[napi(object)]
pub struct BatchBuffers {
    pub in_meta: Uint32Array,
    pub in_data: Buffer,
    pub out_meta: Uint32Array,
    pub out_data: Buffer,
    pub in_slot_u32s: u32,
    pub out_slot_u32s: u32,
}

/// Offline / unit-test batch harness for exercising `parseHttp1Batch` without sockets.
#[napi]
pub struct NifraEngine {
    templates: PreparedTemplates,
    limits: ParseLimits,
    in_meta: Vec<u32>,
    in_data: Vec<u8>,
    out_meta: Vec<u32>,
    out_data: Vec<u8>,
}

#[napi]
impl NifraEngine {
    #[napi(constructor)]
    pub fn new(max_body_size: Option<u32>, oversize_window: Option<u32>) -> Self {
        let mut limits = ParseLimits::default();
        if let Some(v) = max_body_size {
            limits.max_body_size = v as usize;
        }
        if let Some(v) = oversize_window {
            limits.oversize_window = v as usize;
        }
        Self {
            templates: PreparedTemplates::default(),
            limits,
            in_meta: vec![0u32; DEFAULT_IN_SLOTS * IN_SLOT_U32S],
            in_data: vec![0u8; DEFAULT_IN_DATA_BYTES],
            out_meta: vec![0u32; DEFAULT_OUT_SLOTS * OUT_SLOT_U32S],
            out_data: vec![0u8; DEFAULT_OUT_DATA_BYTES],
        }
    }

    #[napi]
    pub fn prepare_response(&mut self, status: u16, flat_headers: Vec<String>) -> u32 {
        let pairs: Vec<(&str, &str)> = flat_headers
            .chunks_exact(2)
            .map(|c| (c[0].as_str(), c[1].as_str()))
            .collect();
        self.templates.register(status, &pairs)
    }

    #[napi]
    pub fn parse_http1_batch(&mut self, raw: Buffer) -> Result<u32> {
        let slice = raw.as_ref();
        let mut offset = 0usize;
        let mut req_id = 1u32;
        let mut packer = BatchPacker::new(&mut self.in_meta, &mut self.in_data);
        while offset < slice.len() {
            match parse_http1(&slice[offset..], self.limits) {
                Ok(ParseStatus::Complete(parsed)) => {
                    if !packer.push(req_id, &parsed) {
                        break;
                    }
                    offset += parsed.total_bytes;
                    req_id += 1;
                }
                Ok(ParseStatus::Incomplete) => break,
                Err(err) => {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!("HTTP/1.1 parse error: {err:?}"),
                    ));
                }
            }
        }
        Ok(packer.count() as u32)
    }

    #[napi]
    pub fn get_batch_buffers(&self) -> BatchBuffers {
        BatchBuffers {
            in_meta: Uint32Array::new(self.in_meta.clone()),
            in_data: Buffer::from(self.in_data.as_slice()),
            out_meta: Uint32Array::new(self.out_meta.clone()),
            out_data: Buffer::from(self.out_data.as_slice()),
            in_slot_u32s: IN_SLOT_U32S as u32,
            out_slot_u32s: OUT_SLOT_U32S as u32,
        }
    }
}

/// Standalone blocking mio HTTP/1.1 echo benchmark runner.
#[napi]
pub fn serve_echo_blocking(host: String, port: u16) -> Result<()> {
    let mut routes = FastRoutes::default();
    routes.add_static_get(
        "/health".into(),
        200,
        &[("content-type", "application/json")],
        br#"{"ok":true}"#,
    );
    routes.add_param_get(
        "/user/".into(),
        "".into(),
        200,
        &[("content-type", "text/plain; charset=utf-8")],
    );

    let mut templates = PreparedTemplates::default();
    let json_ok = templates.register(200, &[("content-type", "application/json")]);
    let not_found = templates.register(404, &[("content-type", "text/plain; charset=utf-8")]);
    let bad_req = templates.register(400, &[("content-type", "text/plain; charset=utf-8")]);

    let cfg = SocketConfig::default();
    let (listener, _addr) = bind_tcp_listener(&host, port, cfg)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
    let limits = ParseLimits::default();

    run_mio_loop(listener, cfg, |read_buf, write_buf| {
        let mut consumed = 0usize;
        let mut close_after = false;
        while consumed < read_buf.len() {
            match parse_http1(&read_buf[consumed..], limits) {
                Ok(ParseStatus::Complete(req)) => {
                    consumed += req.total_bytes;
                    if req.method_idx == 0 && routes.try_match_get(req.path, write_buf) {
                        // Native fast-path hit.
                    } else if req.method_idx == 1 && req.path == "/users" {
                        templates.write_prepared(json_ok, req.body.as_ref(), write_buf);
                    } else {
                        templates.write_prepared(not_found, b"Not Found", write_buf);
                    }
                    if !req.keep_alive {
                        close_after = true;
                        break;
                    }
                }
                Ok(ParseStatus::Incomplete) => break,
                Err(_) => {
                    templates.write_prepared(bad_req, b"Bad Request", write_buf);
                    return ConnAction::CloseAfterWrite {
                        consumed: read_buf.len(),
                    };
                }
            }
        }
        if close_after {
            ConnAction::CloseAfterWrite { consumed }
        } else {
            ConnAction::Continue { consumed }
        }
    })
    .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}
