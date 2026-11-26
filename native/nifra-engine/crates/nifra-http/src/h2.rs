//! Sans-I/O RFC 9113 HTTP/2 + RFC 7541 HPACK server engine with full Huffman decoding,
//! multiplexed streams, flow control, graceful GOAWAY, and rapid-reset (CVE-2023-44487) guards.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::{is_valid_header_name, is_valid_host, method_to_idx};

pub const CLIENT_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

// RFC 9113 §6 frame types.
const FRAME_DATA: u8 = 0x0;
const FRAME_HEADERS: u8 = 0x1;
const FRAME_PRIORITY: u8 = 0x2;
const FRAME_RST_STREAM: u8 = 0x3;
const FRAME_SETTINGS: u8 = 0x4;
const FRAME_PUSH_PROMISE: u8 = 0x5;
const FRAME_PING: u8 = 0x6;
const FRAME_GOAWAY: u8 = 0x7;
const FRAME_WINDOW_UPDATE: u8 = 0x8;
const FRAME_CONTINUATION: u8 = 0x9;

// RFC 9113 frame flags.
const FLAG_END_STREAM: u8 = 0x1;
const FLAG_ACK: u8 = 0x1;
const FLAG_END_HEADERS: u8 = 0x4;
const FLAG_PADDED: u8 = 0x8;
const FLAG_PRIORITY: u8 = 0x20;

// RFC 9113 §7 error codes.
pub const ERR_NO_ERROR: u32 = 0x0;
pub const ERR_PROTOCOL_ERROR: u32 = 0x1;
pub const ERR_INTERNAL_ERROR: u32 = 0x2;
pub const ERR_FLOW_CONTROL_ERROR: u32 = 0x3;
pub const ERR_STREAM_CLOSED: u32 = 0x5;
pub const ERR_FRAME_SIZE_ERROR: u32 = 0x6;
pub const ERR_REFUSED_STREAM: u32 = 0x7;
pub const ERR_CANCEL: u32 = 0x8;
pub const ERR_COMPRESSION_ERROR: u32 = 0x9;
pub const ERR_ENHANCE_YOUR_CALM: u32 = 0xb;

/// Largest HPACK dynamic table a peer may use; the default, since the server never advertises another.
const HPACK_TABLE_LIMIT: usize = 4096;
/// Resets are counted per window, so a long-lived connection that cancels requests now and then is
/// not mistaken for a rapid-reset attack.
const RST_WINDOW: Duration = Duration::from_secs(30);
/// Response bytes a stream may hold back for flow control before the writer is told to wait.
const STREAM_BACKLOG_LIMIT: usize = 1024 * 1024;
/// Response bytes one connection may hold back behind flow control before it is given no more.
const CONN_BACKLOG_LIMIT: usize = 16 * 1024 * 1024;
/// Request body bytes one connection may hold across the streams still receiving. One body of the
/// largest accepted size always fits.
const CONN_BODY_LIMIT: usize = 32 * 1024 * 1024;
const MAX_WINDOW: i64 = 0x7FFF_FFFF;
const DEFAULT_MAX_FRAME_SIZE: usize = 16_384;
const MAX_ALLOWED_FRAME_SIZE: usize = 16_777_215;
const INITIAL_WINDOW_SIZE: i32 = 65_535;
const CONN_RECV_WINDOW_TARGET: u32 = 4 * 1024 * 1024;
const STREAM_RECV_WINDOW_TARGET: u32 = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct H2Config {
    pub max_concurrent_streams: u32,
    pub max_header_list_size: usize,
    pub max_body_size: usize,
    pub oversize_window: usize,
    pub max_rst_streams: u32,
    pub max_empty_frames: u32,
}

impl Default for H2Config {
    fn default() -> Self {
        Self {
            max_concurrent_streams: 128,
            max_header_list_size: 64 * 1024,
            max_body_size: 1_048_576,
            oversize_window: 1_048_576,
            max_rst_streams: 100,
            max_empty_frames: 64,
        }
    }
}

#[derive(Debug, Clone)]
pub struct H2Request {
    pub stream_id: u32,
    pub method_idx: u8,
    pub method: String,
    pub path: String,
    pub query: String,
    pub authority: Option<String>,
    pub host_valid: bool,
    pub is_json_ct: bool,
    pub over_max_body: bool,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum H2Event {
    Request(H2Request),
    StreamReset(u32),
    GoAway,
}

#[derive(Debug, Default)]
pub struct H2FeedResult {
    pub consumed: usize,
    pub events: Vec<H2Event>,
    pub close_after_write: bool,
    /// Streams whose held-back response bytes drained enough for the writer to resume.
    pub writable: Vec<u32>,
}

struct InStream {
    method: String,
    path: String,
    query: String,
    authority: Option<String>,
    headers: Vec<(String, String)>,
    is_json_ct: bool,
    body: Vec<u8>,
    declared_cl: Option<usize>,
    headers_done: bool,
    end_stream: bool,
    started: Instant,
}

/// A response body still owed to the peer: sent as its flow-control windows open.
struct OutStream {
    window: i64,
    buf: Vec<u8>,
    sent: usize,
    end: bool,
    blocked: bool,
}

/// RFC 3986 section 3.1.
fn is_uri_scheme(value: &str) -> bool {
    value.starts_with(|c: char| c.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

/// A field name or value HTTP/2 refuses: upper-case or non-token names, NUL/CR/LF in a value, or a
/// connection-specific field (RFC 9113 sections 8.2 and 8.2.2).
fn invalid_field(name: &str, val: &str) -> bool {
    name.bytes().any(|b| b.is_ascii_uppercase())
        || val.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
        || !is_valid_header_name(name)
        || connection_specific(name, val)
}

fn connection_specific(name: &str, val: &str) -> bool {
    matches!(
        name,
        "connection" | "keep-alive" | "transfer-encoding" | "upgrade" | "proxy-connection"
    ) || (name == "te" && !val.eq_ignore_ascii_case("trailers"))
}

impl OutStream {
    fn new(window: i64) -> Self {
        Self {
            window,
            buf: Vec::new(),
            sent: 0,
            end: false,
            blocked: false,
        }
    }

    fn backlog(&self) -> usize {
        self.buf.len() - self.sent
    }
}

struct HeaderContinuation {
    stream_id: u32,
    end_stream: bool,
    block: Vec<u8>,
    started: Instant,
}

/// Sans-I/O RFC 9113 HTTP/2 server connection state machine.
pub struct H2Conn {
    cfg: H2Config,
    preface_seen: bool,
    server_settings_sent: bool,
    peer_max_frame_size: usize,
    last_stream_id: u32,
    active_streams: HashMap<u32, InStream>,
    open_response_streams: HashMap<u32, ()>,
    continuation: Option<HeaderContinuation>,
    hpack: HpackDecoder,
    rst_count: u32,
    rst_window_start: Option<Instant>,
    clock: fn() -> Instant,
    empty_frame_count: u32,
    goaway_sent: bool,
    closed: bool,
    conn_send_window: i64,
    peer_initial_window: i64,
    out_streams: HashMap<u32, OutStream>,
    /// `WINDOW_UPDATE` credit a peer granted a stream before its response began, applied when it does.
    early_credit: HashMap<u32, i64>,
    client_settings_seen: bool,
    /// When response bytes held by flow control last moved.
    out_progress: Option<Instant>,
}

impl H2Conn {
    pub fn new(cfg: H2Config) -> Self {
        Self {
            cfg,
            preface_seen: false,
            server_settings_sent: false,
            peer_max_frame_size: DEFAULT_MAX_FRAME_SIZE,
            last_stream_id: 0,
            active_streams: HashMap::with_capacity(16),
            open_response_streams: HashMap::with_capacity(16),
            continuation: None,
            hpack: HpackDecoder::new(4096, cfg.max_header_list_size),
            rst_count: 0,
            rst_window_start: None,
            clock: Instant::now,
            empty_frame_count: 0,
            goaway_sent: false,
            closed: false,
            conn_send_window: INITIAL_WINDOW_SIZE as i64,
            peer_initial_window: INITIAL_WINDOW_SIZE as i64,
            out_streams: HashMap::new(),
            early_credit: HashMap::new(),
            client_settings_seen: false,
            out_progress: None,
        }
    }

    /// Response streams the connection still owes the peer: not yet ended, or ended with bytes
    /// held back by flow control.
    pub fn active_response_streams(&self) -> usize {
        self.open_response_streams.len()
            + self
                .out_streams
                .keys()
                .filter(|id| !self.open_response_streams.contains_key(id))
                .count()
    }

    /// When the oldest request still being received (its body unfinished) began, for the request deadline.
    pub fn oldest_incomplete_request(&self) -> Option<Instant> {
        self.active_streams
            .values()
            .map(|st| st.started)
            .chain(self.continuation.iter().map(|cont| cont.started))
            .min()
    }

    /// When a header block still waiting for its `CONTINUATION` frames began.
    pub fn oldest_incomplete_head(&self) -> Option<Instant> {
        self.continuation.as_ref().map(|cont| cont.started)
    }

    /// Since when response bytes held by the peer's flow-control windows have not moved.
    pub fn output_stalled_since(&self) -> Option<Instant> {
        self.out_progress
            .filter(|_| self.queued_response_bytes() > 0)
    }

    /// Whether the peer has caused more stream resets than the window allows, counting this one.
    fn count_reset(&mut self) -> bool {
        let now = (self.clock)();
        match self.rst_window_start {
            Some(start) if now.saturating_duration_since(start) < RST_WINDOW => {
                self.rst_count += 1;
            }
            _ => {
                self.rst_window_start = Some(now);
                self.rst_count = 1;
            }
        }
        self.rst_count > self.cfg.max_rst_streams
    }

    /// Reset a stream the peer broke. Counted with its own `RST_STREAM`s: a peer that makes the
    /// server reset is as costly as one that resets (CVE-2025-8671).
    fn fault(&mut self, stream_id: u32, error_code: u32, out: &mut Vec<u8>) {
        self.reset_stream(stream_id, error_code, out);
        let _ = self.count_reset();
    }

    fn queued_response_bytes(&self) -> usize {
        self.out_streams.values().map(OutStream::backlog).sum()
    }

    fn new_out_stream(&mut self, stream_id: u32) -> OutStream {
        let credit = self.early_credit.remove(&stream_id).unwrap_or(0);
        OutStream::new(self.peer_initial_window + credit)
    }

    /// Emit the initial server `SETTINGS` frame and connection `WINDOW_UPDATE` once.
    pub fn ensure_server_preface(&mut self, out: &mut Vec<u8>) {
        if self.server_settings_sent {
            return;
        }
        self.server_settings_sent = true;
        // SETTINGS: MAX_CONCURRENT_STREAMS (3), INITIAL_WINDOW_SIZE (4), MAX_HEADER_LIST_SIZE (6)
        let mut payload = Vec::with_capacity(18);
        payload.extend_from_slice(&3u16.to_be_bytes());
        payload.extend_from_slice(&self.cfg.max_concurrent_streams.to_be_bytes());
        payload.extend_from_slice(&4u16.to_be_bytes());
        payload.extend_from_slice(&STREAM_RECV_WINDOW_TARGET.to_be_bytes());
        payload.extend_from_slice(&6u16.to_be_bytes());
        payload.extend_from_slice(&(self.cfg.max_header_list_size as u32).to_be_bytes());
        write_frame(FRAME_SETTINGS, 0, 0, &payload, out);

        // Increase connection-level receive window so large POSTs aren't throttled at 64 KiB.
        let delta = CONN_RECV_WINDOW_TARGET.saturating_sub(INITIAL_WINDOW_SIZE as u32);
        if delta > 0 {
            write_frame(FRAME_WINDOW_UPDATE, 0, 0, &delta.to_be_bytes(), out);
        }
    }

    /// Feed raw bytes from TCP/TLS into the HTTP/2 parser.
    pub fn feed(&mut self, buf: &[u8], write_buf: &mut Vec<u8>) -> H2FeedResult {
        let mut res = H2FeedResult::default();
        if self.closed {
            res.consumed = buf.len();
            res.close_after_write = true;
            return res;
        }

        let mut pos = 0usize;
        if !self.preface_seen {
            if buf.len() < CLIENT_PREFACE.len() {
                if !CLIENT_PREFACE.starts_with(buf) {
                    self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                    res.consumed = buf.len();
                    res.close_after_write = true;
                }
                return res;
            }
            if &buf[..CLIENT_PREFACE.len()] != CLIENT_PREFACE {
                self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                res.consumed = buf.len();
                res.close_after_write = true;
                return res;
            }
            self.preface_seen = true;
            pos = CLIENT_PREFACE.len();
            self.ensure_server_preface(write_buf);
        }

        while pos + 9 <= buf.len() {
            if self.rst_count > self.cfg.max_rst_streams {
                break;
            }
            let len = ((buf[pos] as usize) << 16)
                | ((buf[pos + 1] as usize) << 8)
                | (buf[pos + 2] as usize);
            let ftype = buf[pos + 3];
            let flags = buf[pos + 4];
            let stream_id = u32::from_be_bytes([
                buf[pos + 5] & 0x7F,
                buf[pos + 6],
                buf[pos + 7],
                buf[pos + 8],
            ]);

            if len > DEFAULT_MAX_FRAME_SIZE {
                self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                res.consumed = buf.len();
                res.close_after_write = true;
                return res;
            }
            if pos + 9 + len > buf.len() {
                break;
            }

            let payload = &buf[pos + 9..pos + 9 + len];
            pos += 9 + len;

            // If we're expecting a CONTINUATION frame, any other frame is a PROTOCOL_ERROR.
            if self.continuation.is_some() && ftype != FRAME_CONTINUATION {
                self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                res.consumed = pos;
                res.close_after_write = true;
                return res;
            }

            // The first frame after the preface must be the client's own SETTINGS (RFC 9113 §3.4).
            if !self.client_settings_seen {
                if ftype == FRAME_SETTINGS && (flags & FLAG_ACK) == 0 {
                    self.client_settings_seen = true;
                } else {
                    self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                    res.consumed = pos;
                    res.close_after_write = true;
                    return res;
                }
            }

            match ftype {
                FRAME_SETTINGS => {
                    if stream_id != 0 {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    if (flags & FLAG_ACK) != 0 {
                        if !payload.is_empty() {
                            self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                    } else {
                        if payload.len() % 6 != 0 {
                            self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                        let mut window_opened = false;
                        for chunk in payload.chunks_exact(6) {
                            let id = u16::from_be_bytes([chunk[0], chunk[1]]);
                            let val = u32::from_be_bytes([chunk[2], chunk[3], chunk[4], chunk[5]]);
                            match id {
                                // HEADER_TABLE_SIZE (1) sizes the peer's view of the table the server
                                // encodes with, and the server encodes without indexing; the table this
                                // side decodes with is the one it advertised (the 4096 default).
                                4 => {
                                    // INITIAL_WINDOW_SIZE: moves every open stream's send window.
                                    if i64::from(val) > MAX_WINDOW {
                                        self.send_goaway_internal(
                                            ERR_FLOW_CONTROL_ERROR,
                                            write_buf,
                                        );
                                        res.consumed = pos;
                                        res.close_after_write = true;
                                        return res;
                                    }
                                    let delta = i64::from(val) - self.peer_initial_window;
                                    self.peer_initial_window = i64::from(val);
                                    let mut overflow = false;
                                    for os in self.out_streams.values_mut() {
                                        os.window += delta;
                                        overflow |= os.window > MAX_WINDOW;
                                    }
                                    overflow |= self.early_credit.values().any(|credit| {
                                        self.peer_initial_window + credit > MAX_WINDOW
                                    });
                                    if overflow {
                                        self.send_goaway_internal(
                                            ERR_FLOW_CONTROL_ERROR,
                                            write_buf,
                                        );
                                        res.consumed = pos;
                                        res.close_after_write = true;
                                        return res;
                                    }
                                    window_opened = true;
                                }
                                5 => {
                                    // MAX_FRAME_SIZE
                                    if (val as usize) < DEFAULT_MAX_FRAME_SIZE
                                        || (val as usize) > MAX_ALLOWED_FRAME_SIZE
                                    {
                                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                                        res.consumed = pos;
                                        res.close_after_write = true;
                                        return res;
                                    }
                                    self.peer_max_frame_size = val as usize;
                                }
                                _ => {}
                            }
                        }
                        write_frame(FRAME_SETTINGS, FLAG_ACK, 0, &[], write_buf);
                        if window_opened {
                            self.flush_all(write_buf, &mut res.writable);
                        }
                    }
                }
                FRAME_PING => {
                    if stream_id != 0 || payload.len() != 8 {
                        self.send_goaway_internal(
                            if stream_id != 0 {
                                ERR_PROTOCOL_ERROR
                            } else {
                                ERR_FRAME_SIZE_ERROR
                            },
                            write_buf,
                        );
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    if (flags & FLAG_ACK) == 0 {
                        write_frame(FRAME_PING, FLAG_ACK, 0, payload, write_buf);
                    }
                }
                FRAME_WINDOW_UPDATE => {
                    if payload.len() != 4 {
                        self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    let inc =
                        u32::from_be_bytes([payload[0] & 0x7F, payload[1], payload[2], payload[3]]);
                    if inc == 0 {
                        if stream_id == 0 {
                            self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        } else {
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            res.events.push(H2Event::StreamReset(stream_id));
                        }
                    } else if stream_id == 0 {
                        self.conn_send_window += i64::from(inc);
                        if self.conn_send_window > MAX_WINDOW {
                            self.send_goaway_internal(ERR_FLOW_CONTROL_ERROR, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                        self.flush_all(write_buf, &mut res.writable);
                    } else if let Some(os) = self.out_streams.get_mut(&stream_id) {
                        os.window += i64::from(inc);
                        if os.window > MAX_WINDOW {
                            self.fault(stream_id, ERR_FLOW_CONTROL_ERROR, write_buf);
                            res.events.push(H2Event::StreamReset(stream_id));
                        } else {
                            self.flush_stream(stream_id, write_buf, &mut res.writable);
                        }
                    } else if self.active_streams.contains_key(&stream_id)
                        || self.open_response_streams.contains_key(&stream_id)
                    {
                        let credit = self.early_credit.entry(stream_id).or_insert(0);
                        *credit += i64::from(inc);
                        if self.peer_initial_window + *credit > MAX_WINDOW {
                            self.fault(stream_id, ERR_FLOW_CONTROL_ERROR, write_buf);
                            res.events.push(H2Event::StreamReset(stream_id));
                        }
                    }
                }
                FRAME_PRIORITY => {
                    if stream_id == 0 || payload.len() != 5 {
                        self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                }
                FRAME_RST_STREAM => {
                    if stream_id == 0 || payload.len() != 4 {
                        self.send_goaway_internal(ERR_FRAME_SIZE_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    let flooding = self.count_reset();
                    self.active_streams.remove(&stream_id);
                    self.open_response_streams.remove(&stream_id);
                    self.out_streams.remove(&stream_id);
                    self.early_credit.remove(&stream_id);
                    res.events.push(H2Event::StreamReset(stream_id));
                    // Rapid-reset DoS protection (CVE-2023-44487).
                    if flooding {
                        self.send_goaway_internal(ERR_ENHANCE_YOUR_CALM, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                }
                FRAME_GOAWAY => {
                    res.events.push(H2Event::GoAway);
                    if self.active_response_streams() == 0 && self.active_streams.is_empty() {
                        self.closed = true;
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                }
                FRAME_PUSH_PROMISE => {
                    // Clients cannot push to servers (RFC 9113 §8.4).
                    self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                    res.consumed = pos;
                    res.close_after_write = true;
                    return res;
                }
                FRAME_HEADERS => {
                    if stream_id == 0 || (stream_id & 1) == 0 {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    let Some(frag) = strip_headers_padding_and_priority(payload, flags) else {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    };
                    let end_stream = (flags & FLAG_END_STREAM) != 0;
                    let end_headers = (flags & FLAG_END_HEADERS) != 0;
                    let started = (self.clock)();
                    if !end_headers {
                        self.continuation = Some(HeaderContinuation {
                            stream_id,
                            end_stream,
                            block: frag.to_vec(),
                            started,
                        });
                    } else if let Err(conn_err) = self.handle_header_block(
                        stream_id, end_stream, frag, started, write_buf, &mut res,
                    ) {
                        self.send_goaway_internal(conn_err, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                }
                FRAME_CONTINUATION => {
                    let Some(mut cont) = self.continuation.take() else {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    };
                    if cont.stream_id != stream_id {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    if cont.block.len() + payload.len() > self.cfg.max_header_list_size * 2 {
                        self.send_goaway_internal(ERR_ENHANCE_YOUR_CALM, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    if payload.is_empty() && (flags & FLAG_END_HEADERS) == 0 {
                        self.empty_frame_count += 1;
                        if self.empty_frame_count > self.cfg.max_empty_frames {
                            self.send_goaway_internal(ERR_ENHANCE_YOUR_CALM, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                    }
                    cont.block.extend_from_slice(payload);
                    if (flags & FLAG_END_HEADERS) != 0 {
                        if let Err(conn_err) = self.handle_header_block(
                            cont.stream_id,
                            cont.end_stream,
                            &cont.block,
                            cont.started,
                            write_buf,
                            &mut res,
                        ) {
                            self.send_goaway_internal(conn_err, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                    } else {
                        self.continuation = Some(cont);
                    }
                }
                FRAME_DATA => {
                    if stream_id == 0 {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    }
                    let Some(data) = strip_padding(payload, flags) else {
                        self.send_goaway_internal(ERR_PROTOCOL_ERROR, write_buf);
                        res.consumed = pos;
                        res.close_after_write = true;
                        return res;
                    };
                    let end_stream = (flags & FLAG_END_STREAM) != 0;
                    if data.is_empty() && !end_stream {
                        self.empty_frame_count += 1;
                        if self.empty_frame_count > self.cfg.max_empty_frames {
                            self.send_goaway_internal(ERR_ENHANCE_YOUR_CALM, write_buf);
                            res.consumed = pos;
                            res.close_after_write = true;
                            return res;
                        }
                    }
                    // Replenish connection + stream flow-control windows.
                    if !payload.is_empty() {
                        let inc = payload.len() as u32;
                        write_frame(FRAME_WINDOW_UPDATE, 0, 0, &inc.to_be_bytes(), write_buf);
                        if !end_stream {
                            write_frame(
                                FRAME_WINDOW_UPDATE,
                                0,
                                stream_id,
                                &inc.to_be_bytes(),
                                write_buf,
                            );
                        }
                    }
                    let hard_cap = self
                        .cfg
                        .max_body_size
                        .saturating_add(self.cfg.oversize_window);
                    let buffered: usize =
                        self.active_streams.values().map(|st| st.body.len()).sum();
                    if buffered.saturating_add(data.len()) > hard_cap.max(CONN_BODY_LIMIT)
                        && self.active_streams.contains_key(&stream_id)
                    {
                        self.reset_stream(stream_id, ERR_ENHANCE_YOUR_CALM, write_buf);
                        continue;
                    }
                    let mut remove_stream = false;
                    let mut too_large = false;
                    if let Some(st) = self.active_streams.get_mut(&stream_id) {
                        if st.body.len().saturating_add(data.len()) > hard_cap {
                            too_large = true;
                            remove_stream = true;
                        } else if st
                            .declared_cl
                            .is_some_and(|cl| st.body.len() + data.len() > cl)
                        {
                            // More body than content-length declared (RFC 9113 §8.1.1).
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            continue;
                        } else {
                            st.body.extend_from_slice(data);
                            if end_stream {
                                st.end_stream = true;
                                remove_stream = true;
                            }
                        }
                    } else {
                        write_rst_stream(stream_id, ERR_STREAM_CLOSED, write_buf);
                        continue;
                    }
                    if too_large {
                        self.active_streams.remove(&stream_id);
                        self.open_response_streams.insert(stream_id, ());
                        self.write_response(stream_id, 413, &[], None, write_buf);
                    } else if remove_stream {
                        if let Some(st) = self.active_streams.remove(&stream_id) {
                            if st.declared_cl.is_some_and(|cl| cl != st.body.len()) {
                                self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            } else {
                                self.finalize_request(stream_id, st, &mut res);
                            }
                        }
                    }
                }
                _ => {
                    // RFC 9113 §4.1: unknown frame types MUST be ignored.
                }
            }
        }

        if self.rst_count > self.cfg.max_rst_streams {
            self.send_goaway_internal(ERR_ENHANCE_YOUR_CALM, write_buf);
            res.consumed = buf.len();
            res.close_after_write = true;
            return res;
        }
        res.consumed = pos;
        res
    }

    fn handle_header_block(
        &mut self,
        stream_id: u32,
        end_stream: bool,
        block: &[u8],
        started: Instant,
        write_buf: &mut Vec<u8>,
        res: &mut H2FeedResult,
    ) -> Result<(), u32> {
        let decoded = self
            .hpack
            .decode(block)
            .map_err(|_| ERR_COMPRESSION_ERROR)?;
        // The table is now in step with the peer's whatever the bytes were. A target or name that is
        // not UTF-8 fails this request, not the connection and its streams.
        let decoded: Option<Vec<(String, String)>> = decoded
            .into_iter()
            .map(|(name, value)| {
                let name = String::from_utf8(name).ok()?;
                let value = if name.starts_with(':') {
                    String::from_utf8(value).ok()?
                } else {
                    crate::latin1(&value)
                };
                Some((name, value))
            })
            .collect();
        let Some(decoded) = decoded else {
            if stream_id <= self.last_stream_id && !self.active_streams.contains_key(&stream_id) {
                return Err(ERR_PROTOCOL_ERROR);
            }
            self.last_stream_id = self.last_stream_id.max(stream_id);
            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
            return Ok(());
        };

        // Check if this is trailing headers on an already-open stream.
        if let Some(st) = self.active_streams.get_mut(&stream_id) {
            if st.headers_done && end_stream {
                // Trailers are ordinary fields: a pseudo-header, a malformed name or value, or a
                // connection-specific field fails this stream (the table above is already in step).
                if decoded
                    .iter()
                    .any(|(name, val)| name.starts_with(':') || invalid_field(name, val))
                {
                    self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                    return Ok(());
                }
                if let Some(st) = self.active_streams.remove(&stream_id) {
                    if st.declared_cl.is_some_and(|cl| cl != st.body.len()) {
                        self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                    } else {
                        self.finalize_request(stream_id, st, res);
                    }
                }
                return Ok(());
            }
            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
            return Ok(());
        }

        if self.goaway_sent {
            self.fault(stream_id, ERR_REFUSED_STREAM, write_buf);
            return Ok(());
        }
        if stream_id <= self.last_stream_id {
            return Err(ERR_PROTOCOL_ERROR);
        }
        if (self.active_streams.len() + self.active_response_streams()) as u32
            >= self.cfg.max_concurrent_streams
        {
            self.fault(stream_id, ERR_REFUSED_STREAM, write_buf);
            return Ok(());
        }
        self.last_stream_id = stream_id;

        let mut method: Option<String> = None;
        let mut raw_path: Option<String> = None;
        let mut authority: Option<String> = None;
        let mut seen_regular = false;
        let mut seen_scheme = false;
        let mut headers = Vec::with_capacity(decoded.len());
        let mut is_json_ct = false;
        let mut seen_content_type = false;
        let mut declared_cl: Option<usize> = None;
        let mut has_host = false;

        for (name, val) in decoded {
            // RFC 9113 §8.2: header field names MUST be lowercase.
            if name.bytes().any(|b| b.is_ascii_uppercase())
                || val.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
                || (!name.starts_with(':') && !is_valid_header_name(&name))
            {
                self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                return Ok(());
            }
            if name.starts_with(':') {
                if seen_regular {
                    self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                    return Ok(());
                }
                match name.as_str() {
                    ":method" => {
                        if method.is_some() || !is_valid_header_name(&val) {
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            return Ok(());
                        }
                        method = Some(val);
                    }
                    ":path" => {
                        if raw_path.is_some()
                            || !(val.starts_with('/') || val == "*")
                            || val.bytes().any(|b| b <= b' ' || b == 0x7f)
                        {
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            return Ok(());
                        }
                        raw_path = Some(val);
                    }
                    ":authority" => {
                        if authority.is_some() {
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            return Ok(());
                        }
                        authority = Some(val);
                    }
                    ":scheme" => {
                        if seen_scheme || !is_uri_scheme(&val) {
                            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                            return Ok(());
                        }
                        seen_scheme = true;
                    }
                    _ => {
                        self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                        return Ok(());
                    }
                }
                continue;
            }
            seen_regular = true;
            // RFC 9113 §8.2.2: forbidden connection-specific headers.
            if connection_specific(&name, &val) {
                self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                return Ok(());
            }
            if name == "host" {
                if has_host {
                    self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                    return Ok(());
                }
                has_host = true;
                if authority.is_none() {
                    authority = Some(val.clone());
                }
            } else if name == "content-type" {
                // First occurrence wins, matching the HTTP/1 parser.
                if !seen_content_type {
                    seen_content_type = true;
                    let essence = val.split_once(';').map_or(val.as_str(), |(e, _)| e).trim();
                    is_json_ct = essence.eq_ignore_ascii_case("application/json");
                }
            } else if name == "content-length" {
                let digits = val.trim();
                let parsed = if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                    None
                } else {
                    digits.parse::<usize>().ok()
                };
                match parsed {
                    Some(n) if declared_cl.is_none_or(|prev| prev == n) => declared_cl = Some(n),
                    _ => {
                        self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
                        return Ok(());
                    }
                }
            }
            headers.push((name, val));
        }

        let (Some(method), Some(raw_target), true) = (method, raw_path, seen_scheme) else {
            self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
            return Ok(());
        };
        if !has_host {
            if let Some(ref auth) = authority {
                headers.push(("host".to_owned(), auth.clone()));
            }
        }

        let hard_cap = self
            .cfg
            .max_body_size
            .saturating_add(self.cfg.oversize_window);
        if let Some(cl) = declared_cl {
            if cl > hard_cap {
                self.open_response_streams.insert(stream_id, ());
                self.write_response(stream_id, 413, &[], None, write_buf);
                return Ok(());
            }
        }

        let (path, query) = match raw_target.find('?') {
            Some(pos) => (
                raw_target[..pos].to_owned(),
                raw_target[pos + 1..].to_owned(),
            ),
            None => (raw_target, String::new()),
        };

        let st = InStream {
            method,
            path,
            query,
            authority,
            headers,
            is_json_ct,
            body: Vec::new(),
            declared_cl,
            headers_done: true,
            end_stream,
            started,
        };

        if end_stream {
            // Nothing follows the headers, so a declared body that is not empty never arrives.
            if st.declared_cl.is_some_and(|cl| cl != 0) {
                self.fault(stream_id, ERR_PROTOCOL_ERROR, write_buf);
            } else {
                self.finalize_request(stream_id, st, res);
            }
        } else {
            self.active_streams.insert(stream_id, st);
        }
        Ok(())
    }

    fn finalize_request(&mut self, stream_id: u32, st: InStream, res: &mut H2FeedResult) {
        self.open_response_streams.insert(stream_id, ());
        let over_max_body = st.body.len() > self.cfg.max_body_size
            || st.declared_cl.is_some_and(|cl| cl > self.cfg.max_body_size);
        // Judged on the value the request's URL is built from, which a `host` field overrides.
        let host_valid = st
            .headers
            .iter()
            .find(|(name, _)| name == "host")
            .is_some_and(|(_, value)| is_valid_host(value));
        let method_idx = method_to_idx(&st.method);
        res.events.push(H2Event::Request(H2Request {
            stream_id,
            method_idx,
            method: st.method,
            path: st.path,
            query: st.query,
            authority: st.authority,
            host_valid,
            is_json_ct: st.is_json_ct,
            over_max_body,
            headers: st.headers,
            body: st.body,
        }));
    }

    /// Write a complete buffered HTTP/2 response (`HEADERS` + `DATA` frames) and finish the stream.
    pub fn write_response(
        &mut self,
        stream_id: u32,
        status: u16,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
        out: &mut Vec<u8>,
    ) {
        if self.open_response_streams.remove(&stream_id).is_none() {
            // The peer reset this stream (or it never existed): nothing is owed, and a body queued
            // behind a window that will never open would sit in memory until the connection ends.
            return;
        }
        let bodyless = matches!(status, 204 | 205 | 304);
        let body_bytes = if bodyless {
            &[][..]
        } else {
            body.unwrap_or(&[])
        };
        // Checked before the bytes are added, so one response of any size still goes out.
        if !body_bytes.is_empty() && self.queued_response_bytes() >= CONN_BACKLOG_LIMIT {
            self.reset_stream(stream_id, ERR_ENHANCE_YOUR_CALM, out);
            return;
        }
        let mut block = Vec::with_capacity(128);
        let cl_str = if !bodyless {
            let has_cl = headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("content-length"));
            if has_cl {
                None
            } else {
                Some(body_bytes.len().to_string())
            }
        } else {
            None
        };
        encode_response_headers(status, headers, cl_str.as_deref(), &mut block);
        let end_on_headers = body_bytes.is_empty();
        let hflags = FLAG_END_HEADERS | if end_on_headers { FLAG_END_STREAM } else { 0 };
        write_header_frames(stream_id, hflags, &block, self.peer_max_frame_size, out);
        if body_bytes.is_empty() {
            self.early_credit.remove(&stream_id);
        } else {
            self.queue_data(stream_id, body_bytes, true, out);
        }
    }

    /// Write the opening `HEADERS` frame for a streamed HTTP/2 response.
    pub fn write_stream_head(
        &mut self,
        stream_id: u32,
        status: u16,
        headers: &[(&str, &str)],
        content_length: Option<u64>,
        out: &mut Vec<u8>,
    ) {
        let mut block = Vec::with_capacity(128);
        let cl_str = content_length.map(|n| n.to_string());
        encode_response_headers(status, headers, cl_str.as_deref(), &mut block);
        write_header_frames(
            stream_id,
            FLAG_END_HEADERS,
            &block,
            self.peer_max_frame_size,
            out,
        );
        if self.open_response_streams.contains_key(&stream_id) {
            if !self.out_streams.contains_key(&stream_id) {
                let os = self.new_out_stream(stream_id);
                self.out_streams.insert(stream_id, os);
            }
        }
    }

    /// Write `DATA` for a streamed HTTP/2 response, as far as the peer's flow-control windows allow;
    /// the rest waits for its `WINDOW_UPDATE`. Returns `false` when too much is waiting, and the
    /// writer should pause until the stream shows up in [`H2FeedResult::writable`].
    pub fn write_stream_data(
        &mut self,
        stream_id: u32,
        chunk: &[u8],
        end_stream: bool,
        out: &mut Vec<u8>,
    ) -> bool {
        if !self.open_response_streams.contains_key(&stream_id) {
            return true;
        }
        if end_stream {
            self.open_response_streams.remove(&stream_id);
        }
        self.queue_data(stream_id, chunk, end_stream, out);
        let crowded = self.queued_response_bytes() > CONN_BACKLOG_LIMIT;
        match self.out_streams.get_mut(&stream_id) {
            Some(os) if os.backlog() > STREAM_BACKLOG_LIMIT || (crowded && os.backlog() > 0) => {
                os.blocked = true;
                false
            }
            _ => true,
        }
    }

    /// Queue `data` for a response stream and send what the windows allow.
    fn queue_data(&mut self, stream_id: u32, data: &[u8], end_stream: bool, out: &mut Vec<u8>) {
        if data.is_empty() && !end_stream {
            return;
        }
        if !self.out_streams.contains_key(&stream_id) {
            // A whole body that fits the open windows needs no bookkeeping.
            let credit = self.early_credit.get(&stream_id).copied().unwrap_or(0);
            let room = (self.peer_initial_window + credit)
                .min(self.conn_send_window)
                .max(0) as usize;
            if end_stream && data.len() <= room {
                self.early_credit.remove(&stream_id);
                write_data_frames(stream_id, data, true, self.peer_max_frame_size, out);
                self.conn_send_window -= data.len() as i64;
                return;
            }
            let os = self.new_out_stream(stream_id);
            self.out_streams.insert(stream_id, os);
        }
        if self.queued_response_bytes() == 0 {
            self.out_progress = None;
        }
        if let Some(os) = self.out_streams.get_mut(&stream_id) {
            os.buf.extend_from_slice(data);
            os.end |= end_stream;
        }
        self.flush_stream(stream_id, out, &mut Vec::new());
    }

    /// Send as much of one stream's queued response as the windows allow.
    fn flush_stream(&mut self, stream_id: u32, out: &mut Vec<u8>, writable: &mut Vec<u32>) {
        let max_frame = self.peer_max_frame_size;
        let now = (self.clock)();
        let Some(os) = self.out_streams.get_mut(&stream_id) else {
            return;
        };
        let mut finished = false;
        // Progress restarts the stall clock; a backlog that cannot move leaves it running.
        if os.backlog() > 0 {
            if os.window.min(self.conn_send_window) > 0 {
                self.out_progress = Some(now);
            } else {
                self.out_progress.get_or_insert(now);
            }
        }
        while os.backlog() > 0 {
            let room = os.window.min(self.conn_send_window).max(0) as usize;
            if room == 0 {
                break;
            }
            let n = os.backlog().min(room).min(max_frame);
            let last = os.end && n == os.backlog();
            write_frame(
                FRAME_DATA,
                if last { FLAG_END_STREAM } else { 0 },
                stream_id,
                &os.buf[os.sent..os.sent + n],
                out,
            );
            os.sent += n;
            os.window -= n as i64;
            self.conn_send_window -= n as i64;
            finished = last;
        }
        if os.backlog() == 0 {
            if os.end && !finished {
                write_frame(FRAME_DATA, FLAG_END_STREAM, stream_id, &[], out);
                finished = true;
            }
            os.buf.clear();
            os.sent = 0;
        } else if os.sent >= 64 * 1024 && os.sent * 2 >= os.buf.len() {
            os.buf.drain(..os.sent);
            os.sent = 0;
        }
        if finished {
            self.out_streams.remove(&stream_id);
        } else if os.blocked && os.backlog() <= STREAM_BACKLOG_LIMIT / 2 {
            os.blocked = false;
            writable.push(stream_id);
        }
    }

    /// Send what every waiting stream can now go, lowest stream id first.
    fn flush_all(&mut self, out: &mut Vec<u8>, writable: &mut Vec<u32>) {
        let mut ids: Vec<u32> = self
            .out_streams
            .iter()
            .filter(|(_, os)| os.backlog() > 0 || os.end)
            .map(|(&id, _)| id)
            .collect();
        ids.sort_unstable();
        for id in ids {
            if self.conn_send_window <= 0 {
                break;
            }
            self.flush_stream(id, out, writable);
        }
    }

    /// Reset a single HTTP/2 stream (leaving the connection and sibling streams intact).
    pub fn reset_stream(&mut self, stream_id: u32, error_code: u32, out: &mut Vec<u8>) {
        self.active_streams.remove(&stream_id);
        self.open_response_streams.remove(&stream_id);
        self.out_streams.remove(&stream_id);
        self.early_credit.remove(&stream_id);
        write_rst_stream(stream_id, error_code, out);
    }

    /// Send `GOAWAY(NO_ERROR)` for graceful shutdown.
    pub fn send_goaway(&mut self, error_code: u32, out: &mut Vec<u8>) {
        self.send_goaway_internal(error_code, out);
    }

    fn send_goaway_internal(&mut self, error_code: u32, out: &mut Vec<u8>) {
        if self.goaway_sent {
            return;
        }
        self.goaway_sent = true;
        let mut payload = [0u8; 8];
        payload[0..4].copy_from_slice(&(self.last_stream_id & 0x7FFF_FFFF).to_be_bytes());
        payload[4..8].copy_from_slice(&error_code.to_be_bytes());
        write_frame(FRAME_GOAWAY, 0, 0, &payload, out);
        if error_code != ERR_NO_ERROR {
            self.closed = true;
        }
    }
}

fn write_frame(ftype: u8, flags: u8, stream_id: u32, payload: &[u8], out: &mut Vec<u8>) {
    let len = payload.len();
    out.push(((len >> 16) & 0xFF) as u8);
    out.push(((len >> 8) & 0xFF) as u8);
    out.push((len & 0xFF) as u8);
    out.push(ftype);
    out.push(flags);
    out.extend_from_slice(&(stream_id & 0x7FFF_FFFF).to_be_bytes());
    out.extend_from_slice(payload);
}

fn write_rst_stream(stream_id: u32, error_code: u32, out: &mut Vec<u8>) {
    write_frame(
        FRAME_RST_STREAM,
        0,
        stream_id,
        &error_code.to_be_bytes(),
        out,
    );
}

fn write_header_frames(
    stream_id: u32,
    flags: u8,
    block: &[u8],
    max_frame: usize,
    out: &mut Vec<u8>,
) {
    if block.len() <= max_frame {
        write_frame(FRAME_HEADERS, flags, stream_id, block, out);
        return;
    }
    let end_stream_flag = flags & FLAG_END_STREAM;
    let first_end = max_frame.min(block.len());
    write_frame(
        FRAME_HEADERS,
        end_stream_flag,
        stream_id,
        &block[..first_end],
        out,
    );
    let mut off = first_end;
    while off < block.len() {
        let end = (off + max_frame).min(block.len());
        let cont_flags = if end == block.len() {
            FLAG_END_HEADERS
        } else {
            0
        };
        write_frame(
            FRAME_CONTINUATION,
            cont_flags,
            stream_id,
            &block[off..end],
            out,
        );
        off = end;
    }
}

fn write_data_frames(
    stream_id: u32,
    data: &[u8],
    end_stream: bool,
    max_frame: usize,
    out: &mut Vec<u8>,
) {
    if data.is_empty() {
        if end_stream {
            write_frame(FRAME_DATA, FLAG_END_STREAM, stream_id, &[], out);
        }
        return;
    }
    let mut off = 0usize;
    while off < data.len() {
        let end = (off + max_frame).min(data.len());
        let flags = if end_stream && end == data.len() {
            FLAG_END_STREAM
        } else {
            0
        };
        write_frame(FRAME_DATA, flags, stream_id, &data[off..end], out);
        off = end;
    }
}

fn strip_padding(payload: &[u8], flags: u8) -> Option<&[u8]> {
    if (flags & FLAG_PADDED) == 0 {
        return Some(payload);
    }
    let pad = *payload.first()? as usize;
    if 1 + pad > payload.len() {
        return None;
    }
    Some(&payload[1..payload.len() - pad])
}

fn strip_headers_padding_and_priority(payload: &[u8], flags: u8) -> Option<&[u8]> {
    let mut start = 0usize;
    let mut end = payload.len();
    if (flags & FLAG_PADDED) != 0 {
        let pad = *payload.first()? as usize;
        start += 1;
        if start + pad > end {
            return None;
        }
        end -= pad;
    }
    if (flags & FLAG_PRIORITY) != 0 {
        if start + 5 > end {
            return None;
        }
        start += 5;
    }
    Some(&payload[start..end])
}

// ---------------------------------------------------------------------------
// RFC 7541 HPACK Encoder & Decoder
// ---------------------------------------------------------------------------

fn encode_response_headers(
    status: u16,
    headers: &[(&str, &str)],
    content_length: Option<&str>,
    out: &mut Vec<u8>,
) {
    // :status pseudo-header
    match status {
        200 => out.push(0x88),
        204 => out.push(0x89),
        206 => out.push(0x8a),
        304 => out.push(0x8b),
        400 => out.push(0x8c),
        404 => out.push(0x8d),
        500 => out.push(0x8e),
        _ => {
            let mut num = itoa::Buffer::new();
            let s = num.format(status);
            // Literal without indexing, indexed name :status (8)
            out.push(0x08);
            encode_hpack_str(s.as_bytes(), out);
        }
    }

    for &(k, v) in headers {
        let lower = k.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "connection" | "keep-alive" | "transfer-encoding" | "upgrade" | "proxy-connection"
        ) {
            continue;
        }
        if lower == "date" {
            continue;
        }
        encode_header_pair(&lower, v.as_bytes(), out);
    }

    encode_header_pair("date", &crate::date::now(), out);
    if let Some(cl) = content_length {
        encode_header_pair("content-length", cl.as_bytes(), out);
    }
}

fn encode_header_pair(name_lower: &str, value: &[u8], out: &mut Vec<u8>) {
    let static_idx = match name_lower {
        "cache-control" => Some(24u8),
        "content-length" => Some(28u8),
        "content-type" => Some(31u8),
        "date" => Some(33u8),
        "etag" => Some(34u8),
        "location" => Some(46u8),
        "server" => Some(54u8),
        "set-cookie" => Some(55u8),
        "vary" => Some(59u8),
        _ => None,
    };
    if let Some(idx) = static_idx {
        // Literal header field without indexing (0000xxxx, 4-bit prefix)
        encode_hpack_int(idx as usize, 4, 0x00, out);
    } else {
        out.push(0x00);
        encode_hpack_str(name_lower.as_bytes(), out);
    }
    encode_hpack_str(value, out);
}

fn encode_hpack_int(mut value: usize, prefix_bits: u8, first_mask: u8, out: &mut Vec<u8>) {
    let max_prefix = (1usize << prefix_bits) - 1;
    if value < max_prefix {
        out.push(first_mask | (value as u8));
        return;
    }
    out.push(first_mask | (max_prefix as u8));
    value -= max_prefix;
    while value >= 128 {
        out.push(((value & 0x7F) as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn encode_hpack_str(bytes: &[u8], out: &mut Vec<u8>) {
    encode_hpack_int(bytes.len(), 7, 0x00, out);
    out.extend_from_slice(bytes);
}

/// One decoded header as raw bytes: `(name, value)`.
type HeaderBytes = (Vec<u8>, Vec<u8>);

struct HpackDecoder {
    // Bytes, not text: a header value is only required to be bytes, and the table must stay in step
    // with the peer's whatever they hold.
    dynamic: VecDeque<(Vec<u8>, Vec<u8>)>,
    dynamic_size: usize,
    max_dynamic_size: usize,
    max_header_list_size: usize,
}

impl HpackDecoder {
    fn new(max_dynamic_size: usize, max_header_list_size: usize) -> Self {
        Self {
            dynamic: VecDeque::new(),
            dynamic_size: 0,
            max_dynamic_size,
            max_header_list_size,
        }
    }

    fn set_max_table_size(&mut self, max_size: usize) {
        self.max_dynamic_size = max_size;
        self.evict();
    }

    fn evict(&mut self) {
        while self.dynamic_size > self.max_dynamic_size {
            if let Some((k, v)) = self.dynamic.pop_back() {
                self.dynamic_size = self.dynamic_size.saturating_sub(k.len() + v.len() + 32);
            } else {
                self.dynamic_size = 0;
                break;
            }
        }
    }

    fn insert(&mut self, name: Vec<u8>, value: Vec<u8>) {
        let entry_size = name.len() + value.len() + 32;
        if entry_size > self.max_dynamic_size {
            self.dynamic.clear();
            self.dynamic_size = 0;
            return;
        }
        self.dynamic_size += entry_size;
        self.dynamic.push_front((name, value));
        self.evict();
    }

    fn get(&self, index: usize) -> Result<(&[u8], &[u8]), ()> {
        if index == 0 {
            return Err(());
        }
        if index <= STATIC_TABLE.len() {
            let (k, v) = STATIC_TABLE[index - 1];
            return Ok((k.as_bytes(), v.as_bytes()));
        }
        let dyn_idx = index - STATIC_TABLE.len() - 1;
        let (k, v) = self.dynamic.get(dyn_idx).ok_or(())?;
        Ok((k.as_slice(), v.as_slice()))
    }

    fn decode(&mut self, buf: &[u8]) -> Result<Vec<HeaderBytes>, ()> {
        let mut out = Vec::with_capacity(16);
        let mut total_size = 0usize;
        let mut pos = 0usize;

        while pos < buf.len() {
            let b = buf[pos];
            if (b & 0x80) != 0 {
                // Indexed Header Field (RFC 7541 §6.1)
                let (idx, used) = decode_hpack_int(&buf[pos..], 7)?;
                pos += used;
                let (k, v) = self.get(idx)?;
                total_size += k.len() + v.len() + 32;
                if total_size > self.max_header_list_size {
                    return Err(());
                }
                out.push((k.to_owned(), v.to_owned()));
            } else if (b & 0x40) != 0 {
                // Literal with Incremental Indexing (RFC 7541 §6.2.1)
                let (idx, used) = decode_hpack_int(&buf[pos..], 6)?;
                pos += used;
                let name = if idx == 0 {
                    let (s, u) = decode_hpack_str(&buf[pos..])?;
                    pos += u;
                    s
                } else {
                    self.get(idx)?.0.to_owned()
                };
                let (val, u) = decode_hpack_str(&buf[pos..])?;
                pos += u;
                total_size += name.len() + val.len() + 32;
                if total_size > self.max_header_list_size {
                    return Err(());
                }
                self.insert(name.clone(), val.clone());
                out.push((name, val));
            } else if (b & 0x20) != 0 {
                // Dynamic Table Size Update (RFC 7541 §6.3)
                let (new_max, used) = decode_hpack_int(&buf[pos..], 5)?;
                pos += used;
                if new_max > HPACK_TABLE_LIMIT {
                    return Err(());
                }
                self.set_max_table_size(new_max);
            } else {
                // Literal without Indexing / Never Indexed (RFC 7541 §6.2.2 / §6.2.3)
                let (idx, used) = decode_hpack_int(&buf[pos..], 4)?;
                pos += used;
                let name = if idx == 0 {
                    let (s, u) = decode_hpack_str(&buf[pos..])?;
                    pos += u;
                    s
                } else {
                    self.get(idx)?.0.to_owned()
                };
                let (val, u) = decode_hpack_str(&buf[pos..])?;
                pos += u;
                total_size += name.len() + val.len() + 32;
                if total_size > self.max_header_list_size {
                    return Err(());
                }
                out.push((name, val));
            }
        }

        Ok(out)
    }
}

fn decode_hpack_int(buf: &[u8], prefix_bits: u8) -> Result<(usize, usize), ()> {
    if buf.is_empty() {
        return Err(());
    }
    let mask = ((1u16 << prefix_bits) - 1) as u8;
    let mut val = (buf[0] & mask) as usize;
    if val < mask as usize {
        return Ok((val, 1));
    }
    let mut m = 0u32;
    let mut pos = 1usize;
    loop {
        if pos >= buf.len() || m > 28 {
            return Err(());
        }
        let b = buf[pos];
        pos += 1;
        val = val.checked_add(((b & 0x7F) as usize) << m).ok_or(())?;
        if (b & 0x80) == 0 {
            return Ok((val, pos));
        }
        m += 7;
    }
}

fn decode_hpack_str(buf: &[u8]) -> Result<(Vec<u8>, usize), ()> {
    if buf.is_empty() {
        return Err(());
    }
    let huffman = (buf[0] & 0x80) != 0;
    let (len, used) = decode_hpack_int(buf, 7)?;
    let end = used.checked_add(len).ok_or(())?;
    if end > buf.len() {
        return Err(());
    }
    let raw = &buf[used..end];
    let bytes = if huffman {
        huffman_decode(raw)?
    } else {
        raw.to_vec()
    };
    Ok((bytes, end))
}

const STATIC_TABLE: [(&str, &str); 61] = [
    (":authority", ""),
    (":method", "GET"),
    (":method", "POST"),
    (":path", "/"),
    (":path", "/index.html"),
    (":scheme", "http"),
    (":scheme", "https"),
    (":status", "200"),
    (":status", "204"),
    (":status", "206"),
    (":status", "304"),
    (":status", "400"),
    (":status", "404"),
    (":status", "500"),
    ("accept-charset", ""),
    ("accept-encoding", "gzip, deflate"),
    ("accept-language", ""),
    ("accept-ranges", ""),
    ("accept", ""),
    ("access-control-allow-origin", ""),
    ("age", ""),
    ("allow", ""),
    ("authorization", ""),
    ("cache-control", ""),
    ("content-disposition", ""),
    ("content-encoding", ""),
    ("content-language", ""),
    ("content-length", ""),
    ("content-location", ""),
    ("content-range", ""),
    ("content-type", ""),
    ("cookie", ""),
    ("date", ""),
    ("etag", ""),
    ("expect", ""),
    ("expires", ""),
    ("from", ""),
    ("host", ""),
    ("if-match", ""),
    ("if-modified-since", ""),
    ("if-none-match", ""),
    ("if-range", ""),
    ("if-unmodified-since", ""),
    ("last-modified", ""),
    ("link", ""),
    ("location", ""),
    ("max-forwards", ""),
    ("proxy-authenticate", ""),
    ("proxy-authorization", ""),
    ("range", ""),
    ("referer", ""),
    ("refresh", ""),
    ("retry-after", ""),
    ("server", ""),
    ("set-cookie", ""),
    ("strict-transport-security", ""),
    ("transfer-encoding", ""),
    ("user-agent", ""),
    ("vary", ""),
    ("via", ""),
    ("www-authenticate", ""),
];

// RFC 7541 Appendix B Huffman codes: `(code, bit_len)` for symbols 0..=255.
const HUFFMAN_TABLE: [(u32, u8); 256] = [
    (0x1ff8, 13),
    (0x7fffd8, 23),
    (0xfffffe2, 28),
    (0xfffffe3, 28),
    (0xfffffe4, 28),
    (0xfffffe5, 28),
    (0xfffffe6, 28),
    (0xfffffe7, 28),
    (0xfffffe8, 28),
    (0xffffea, 24),
    (0x3ffffffc, 30),
    (0xfffffe9, 28),
    (0xfffffea, 28),
    (0x3ffffffd, 30),
    (0xfffffeb, 28),
    (0xfffffec, 28),
    (0xfffffed, 28),
    (0xfffffee, 28),
    (0xfffffef, 28),
    (0xffffff0, 28),
    (0xffffff1, 28),
    (0xffffff2, 28),
    (0x3ffffffe, 30),
    (0xffffff3, 28),
    (0xffffff4, 28),
    (0xffffff5, 28),
    (0xffffff6, 28),
    (0xffffff7, 28),
    (0xffffff8, 28),
    (0xffffff9, 28),
    (0xffffffa, 28),
    (0xffffffb, 28),
    (0x14, 6),
    (0x3f8, 10),
    (0x3f9, 10),
    (0xffa, 12),
    (0x1ff9, 13),
    (0x15, 6),
    (0xf8, 8),
    (0x7fa, 11),
    (0x3fa, 10),
    (0x3fb, 10),
    (0xf9, 8),
    (0x7fb, 11),
    (0xfa, 8),
    (0x16, 6),
    (0x17, 6),
    (0x18, 6),
    (0x0, 5),
    (0x1, 5),
    (0x2, 5),
    (0x19, 6),
    (0x1a, 6),
    (0x1b, 6),
    (0x1c, 6),
    (0x1d, 6),
    (0x1e, 6),
    (0x1f, 6),
    (0x5c, 7),
    (0xfb, 8),
    (0x7ffc, 15),
    (0x20, 6),
    (0xffb, 12),
    (0x3fc, 10),
    (0x1ffa, 13),
    (0x21, 6),
    (0x5d, 7),
    (0x5e, 7),
    (0x5f, 7),
    (0x60, 7),
    (0x61, 7),
    (0x62, 7),
    (0x63, 7),
    (0x64, 7),
    (0x65, 7),
    (0x66, 7),
    (0x67, 7),
    (0x68, 7),
    (0x69, 7),
    (0x6a, 7),
    (0x6b, 7),
    (0x6c, 7),
    (0x6d, 7),
    (0x6e, 7),
    (0x6f, 7),
    (0x70, 7),
    (0x71, 7),
    (0x72, 7),
    (0xfc, 8),
    (0x73, 7),
    (0xfd, 8),
    (0x1ffb, 13),
    (0x7fff0, 19),
    (0x1ffc, 13),
    (0x3ffc, 14),
    (0x22, 6),
    (0x7ffd, 15),
    (0x3, 5),
    (0x23, 6),
    (0x4, 5),
    (0x24, 6),
    (0x5, 5),
    (0x25, 6),
    (0x26, 6),
    (0x27, 6),
    (0x6, 5),
    (0x74, 7),
    (0x75, 7),
    (0x28, 6),
    (0x29, 6),
    (0x2a, 6),
    (0x7, 5),
    (0x2b, 6),
    (0x76, 7),
    (0x2c, 6),
    (0x8, 5),
    (0x9, 5),
    (0x2d, 6),
    (0x77, 7),
    (0x78, 7),
    (0x79, 7),
    (0x7a, 7),
    (0x7b, 7),
    (0x7ffe, 15),
    (0x7fc, 11),
    (0x3ffd, 14),
    (0x1ffd, 13),
    (0xffffffc, 28),
    (0xfffe6, 20),
    (0x3fffd2, 22),
    (0xfffe7, 20),
    (0xfffe8, 20),
    (0x3fffd3, 22),
    (0x3fffd4, 22),
    (0x3fffd5, 22),
    (0x7fffd9, 23),
    (0x3fffd6, 22),
    (0x7fffda, 23),
    (0x7fffdb, 23),
    (0x7fffdc, 23),
    (0x7fffdd, 23),
    (0x7fffde, 23),
    (0xffffeb, 24),
    (0x7fffdf, 23),
    (0xffffec, 24),
    (0xffffed, 24),
    (0x3fffd7, 22),
    (0x7fffe0, 23),
    (0xffffee, 24),
    (0x7fffe1, 23),
    (0x7fffe2, 23),
    (0x7fffe3, 23),
    (0x7fffe4, 23),
    (0x1fffdc, 21),
    (0x3fffd8, 22),
    (0x7fffe5, 23),
    (0x3fffd9, 22),
    (0x7fffe6, 23),
    (0x7fffe7, 23),
    (0xffffef, 24),
    (0x3fffda, 22),
    (0x1fffdd, 21),
    (0xfffe9, 20),
    (0x3fffdb, 22),
    (0x3fffdc, 22),
    (0x7fffe8, 23),
    (0x7fffe9, 23),
    (0x1fffde, 21),
    (0x7fffea, 23),
    (0x3fffdd, 22),
    (0x3fffde, 22),
    (0xfffff0, 24),
    (0x1fffdf, 21),
    (0x3fffdf, 22),
    (0x7fffeb, 23),
    (0x7fffec, 23),
    (0x1fffe0, 21),
    (0x1fffe1, 21),
    (0x3fffe0, 22),
    (0x1fffe2, 21),
    (0x7fffed, 23),
    (0x3fffe1, 22),
    (0x7fffee, 23),
    (0x7fffef, 23),
    (0xfffea, 20),
    (0x3fffe2, 22),
    (0x3fffe3, 22),
    (0x3fffe4, 22),
    (0x7ffff0, 23),
    (0x3fffe5, 22),
    (0x3fffe6, 22),
    (0x7ffff1, 23),
    (0x3ffffe0, 26),
    (0x3ffffe1, 26),
    (0xfffeb, 20),
    (0x7fff1, 19),
    (0x3fffe7, 22),
    (0x7ffff2, 23),
    (0x3fffe8, 22),
    (0x1ffffec, 25),
    (0x3ffffe2, 26),
    (0x3ffffe3, 26),
    (0x3ffffe4, 26),
    (0x7ffffde, 27),
    (0x7ffffdf, 27),
    (0x3ffffe5, 26),
    (0xfffff1, 24),
    (0x1ffffed, 25),
    (0x7fff2, 19),
    (0x1fffe3, 21),
    (0x3ffffe6, 26),
    (0x7ffffe0, 27),
    (0x7ffffe1, 27),
    (0x3ffffe7, 26),
    (0x7ffffe2, 27),
    (0xfffff2, 24),
    (0x1fffe4, 21),
    (0x1fffe5, 21),
    (0x3ffffe8, 26),
    (0x3ffffe9, 26),
    (0xffffffd, 28),
    (0x7ffffe3, 27),
    (0x7ffffe4, 27),
    (0x7ffffe5, 27),
    (0xfffec, 20),
    (0xfffff3, 24),
    (0xfffed, 20),
    (0x1fffe6, 21),
    (0x3fffe9, 22),
    (0x1fffe7, 21),
    (0x1fffe8, 21),
    (0x7ffff3, 23),
    (0x3fffea, 22),
    (0x3fffeb, 22),
    (0x1ffffee, 25),
    (0x1ffffef, 25),
    (0xfffff4, 24),
    (0xfffff5, 24),
    (0x3ffffea, 26),
    (0x7ffff4, 23),
    (0x3ffffeb, 26),
    (0x7ffffe6, 27),
    (0x3ffffec, 26),
    (0x3ffffed, 26),
    (0x7ffffe7, 27),
    (0x7ffffe8, 27),
    (0x7ffffe9, 27),
    (0x7ffffea, 27),
    (0x7ffffeb, 27),
    (0xffffffe, 28),
    (0x7ffffec, 27),
    (0x7ffffed, 27),
    (0x7ffffee, 27),
    (0x7ffffef, 27),
    (0x7fffff0, 27),
    (0x3ffffee, 26),
];

struct HuffNode {
    children: [u16; 2],
    sym: Option<u8>,
}

fn huffman_trie() -> &'static [HuffNode] {
    use std::sync::OnceLock;
    static TRIE: OnceLock<Vec<HuffNode>> = OnceLock::new();
    TRIE.get_or_init(|| {
        let mut nodes = vec![HuffNode {
            children: [0, 0],
            sym: None,
        }];
        for (sym, &(code, len)) in HUFFMAN_TABLE.iter().enumerate() {
            let mut cur = 0usize;
            for bit_idx in (0..len).rev() {
                let bit = ((code >> bit_idx) & 1) as usize;
                let next = nodes[cur].children[bit] as usize;
                if next == 0 {
                    let new_idx = nodes.len() as u16;
                    nodes.push(HuffNode {
                        children: [0, 0],
                        sym: None,
                    });
                    nodes[cur].children[bit] = new_idx;
                    cur = new_idx as usize;
                } else {
                    cur = next;
                }
            }
            nodes[cur].sym = Some(sym as u8);
        }
        nodes
    })
}

fn huffman_decode(input: &[u8]) -> Result<Vec<u8>, ()> {
    let trie = huffman_trie();
    let mut out = Vec::with_capacity(input.len() * 2);
    let mut cur = 0usize;
    let mut pending_bits = 0u8;
    let mut all_ones = true;

    for &byte in input {
        for shift in (0..8).rev() {
            let bit = ((byte >> shift) & 1) as usize;
            if bit == 0 {
                all_ones = false;
            }
            pending_bits += 1;
            let next = trie[cur].children[bit] as usize;
            if next == 0 {
                // EOS or invalid prefix.
                return Err(());
            }
            cur = next;
            if let Some(sym) = trie[cur].sym {
                out.push(sym);
                cur = 0;
                pending_bits = 0;
                all_ones = true;
            }
        }
    }

    // RFC 7541 §5.2: trailing padding must be < 8 bits of all 1s.
    if pending_bits >= 8 || (pending_bits > 0 && !all_ones) {
        return Err(());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hpack_decodes_rfc7541_huffman_example() {
        // RFC 7541 C.4.1: "www.example.com" Huffman-encoded = f1e3 c2e5 f23a 6ba0 ab90 f4ff
        let encoded = [
            0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff,
        ];
        assert_eq!(huffman_decode(&encoded).unwrap(), b"www.example.com");
    }

    #[test]
    fn h2_handles_preface_multiplexed_get_and_post() {
        let mut conn = H2Conn::new(H2Config::default());
        let mut wire = Vec::new();
        wire.extend_from_slice(CLIENT_PREFACE);
        // Empty client SETTINGS
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        // Stream 1: GET / (indexed :method=GET (2), :path=/ (4), :scheme=http (6))
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &[0x82, 0x84, 0x86],
            &mut wire,
        );
        // Stream 3: POST /echo with JSON body
        let mut h3 = Vec::new();
        h3.push(0x83); // :method POST
        h3.push(0x04); // :path literal
        encode_hpack_str(b"/echo?n=1", &mut h3);
        h3.push(0x86); // :scheme http
        encode_header_pair("content-type", b"application/json", &mut h3);
        write_frame(FRAME_HEADERS, FLAG_END_HEADERS, 3, &h3, &mut wire);
        write_frame(FRAME_DATA, FLAG_END_STREAM, 3, br#"{"ok":1}"#, &mut wire);

        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert_eq!(res.consumed, wire.len());
        assert!(!res.close_after_write);
        assert_eq!(res.events.len(), 2);

        match &res.events[0] {
            H2Event::Request(r) => {
                assert_eq!(r.stream_id, 1);
                assert_eq!(r.method, "GET");
                assert_eq!(r.path, "/");
            }
            _ => panic!("expected request on stream 1"),
        }
        match &res.events[1] {
            H2Event::Request(r) => {
                assert_eq!(r.stream_id, 3);
                assert_eq!(r.method, "POST");
                assert_eq!(r.path, "/echo");
                assert_eq!(r.query, "n=1");
                assert!(r.is_json_ct);
                assert_eq!(r.body, br#"{"ok":1}"#);
            }
            _ => panic!("expected request on stream 3"),
        }

        // Write response for stream 1 and verify HEADERS + DATA framing.
        let mut resp = Vec::new();
        conn.write_response(
            1,
            200,
            &[("x-fixed", "1"), ("connection", "keep-alive")],
            Some(b"ok"),
            &mut resp,
        );
        assert!(resp.len() > 9);
        assert_eq!(resp[3], FRAME_HEADERS);
        assert_eq!(conn.active_response_streams(), 1); // stream 3 still open
    }

    #[test]
    fn h2_content_type_is_classified_without_slicing_utf8() {
        // `application/jso` + `é` puts a char boundary-straddling byte at offset 16.
        let cases: [(&str, bool); 6] = [
            ("application/jso\u{e9}", false),
            ("application/json-evil", false),
            ("application/json", true),
            ("Application/JSON; charset=utf-8", true),
            ("  application/json  ;x=1", true),
            ("text/plain", false),
        ];
        for (value, expected) in cases {
            let mut conn = H2Conn::new(H2Config::default());
            let mut wire = CLIENT_PREFACE.to_vec();
            write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
            let mut block = vec![0x82, 0x84, 0x86];
            encode_header_pair("content-type", value.as_bytes(), &mut block);
            write_frame(
                FRAME_HEADERS,
                FLAG_END_HEADERS | FLAG_END_STREAM,
                1,
                &block,
                &mut wire,
            );
            let res = conn.feed(&wire, &mut Vec::new());
            let Some(H2Event::Request(req)) = res.events.first() else {
                panic!("expected a request for {value:?}");
            };
            assert_eq!(req.is_json_ct, expected, "{value:?}");
        }
    }

    fn frames(wire: &[u8]) -> Vec<(u8, u8, u32, Vec<u8>)> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos + 9 <= wire.len() {
            let len = ((wire[pos] as usize) << 16)
                | ((wire[pos + 1] as usize) << 8)
                | wire[pos + 2] as usize;
            let sid = u32::from_be_bytes([
                wire[pos + 5] & 0x7F,
                wire[pos + 6],
                wire[pos + 7],
                wire[pos + 8],
            ]);
            out.push((
                wire[pos + 3],
                wire[pos + 4],
                sid,
                wire[pos + 9..pos + 9 + len].to_vec(),
            ));
            pos += 9 + len;
        }
        out
    }

    fn data_bytes(wire: &[u8], stream: u32) -> (usize, bool) {
        let mut total = 0;
        let mut ended = false;
        for (ty, flags, sid, payload) in frames(wire) {
            if ty == FRAME_DATA && sid == stream {
                total += payload.len();
                ended |= flags & FLAG_END_STREAM != 0;
            }
        }
        (total, ended)
    }

    /// A connection with one open request on stream 1, past the preface and SETTINGS exchange.
    fn open_conn(cfg: H2Config) -> H2Conn {
        let mut conn = H2Conn::new(cfg);
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &[0x82, 0x84, 0x86],
            &mut wire,
        );
        let res = conn.feed(&wire, &mut Vec::new());
        assert!(matches!(res.events.first(), Some(H2Event::Request(_))));
        conn
    }

    fn window_update(stream: u32, inc: u32) -> Vec<u8> {
        let mut wire = Vec::new();
        write_frame(
            FRAME_WINDOW_UPDATE,
            0,
            stream,
            &inc.to_be_bytes(),
            &mut wire,
        );
        wire
    }

    #[test]
    fn h2_response_waits_for_the_peers_flow_control_window() {
        let mut conn = open_conn(H2Config::default());
        let body = vec![7u8; 100_000];
        let mut out = Vec::new();
        conn.write_response(1, 200, &[], Some(&body), &mut out);
        // Only the default 65_535-byte window may be used, and the stream is not finished.
        assert_eq!(data_bytes(&out, 1), (65_535, false));

        // A stream-level update alone is not enough: the connection window is spent.
        let mut more = Vec::new();
        conn.feed(&window_update(1, 100_000), &mut more);
        assert_eq!(data_bytes(&more, 1), (0, false));

        // Opening the connection window releases the rest, with END_STREAM on the last frame.
        let mut rest = Vec::new();
        conn.feed(&window_update(0, 100_000), &mut rest);
        assert_eq!(data_bytes(&rest, 1), (100_000 - 65_535, true));
        assert_eq!(conn.active_response_streams(), 0);
    }

    #[test]
    fn h2_initial_window_setting_moves_open_stream_windows() {
        let mut conn = open_conn(H2Config::default());
        let mut out = Vec::new();
        conn.write_response(1, 200, &[], Some(&vec![1u8; 70_000]), &mut out);
        assert_eq!(data_bytes(&out, 1).0, 65_535);
        // Connection window first (SETTINGS does not touch it), then a bigger stream window (983_040).
        conn.feed(&window_update(0, 1_000_000), &mut Vec::new());
        let mut settings = Vec::new();
        write_frame(FRAME_SETTINGS, 0, 0, &[0, 4, 0, 0x0F, 0, 0], &mut settings);
        let mut rest = Vec::new();
        conn.feed(&settings, &mut rest);
        assert_eq!(data_bytes(&rest, 1), (70_000 - 65_535, true));
    }

    #[test]
    fn h2_streamed_response_reports_backpressure_and_resumes() {
        let mut conn = open_conn(H2Config::default());
        let mut out = Vec::new();
        conn.write_stream_head(1, 200, &[], None, &mut out);
        let chunk = vec![3u8; 512 * 1024];
        assert!(conn.write_stream_data(1, &chunk, false, &mut out));
        // 65_535 went out; the backlog is now 458_753 bytes, then 971_265, then past the 1 MiB limit.
        assert!(conn.write_stream_data(1, &chunk, false, &mut out));
        assert!(!conn.write_stream_data(1, &chunk, false, &mut out));
        let mut sink = Vec::new();
        let first = conn.feed(&window_update(0, 4_000_000), &mut sink);
        assert!(first.writable.is_empty(), "stream window is still shut");
        let second = conn.feed(&window_update(1, 4_000_000), &mut sink);
        assert_eq!(second.writable, vec![1]);
        assert_eq!(data_bytes(&sink, 1).0, 3 * 512 * 1024 - 65_535);
    }

    #[test]
    fn h2_resets_are_counted_per_window() {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::OnceLock;
        static BASE: OnceLock<Instant> = OnceLock::new();
        static OFFSET_MS: AtomicU64 = AtomicU64::new(0);
        fn fake_now() -> Instant {
            *BASE.get_or_init(Instant::now)
                + Duration::from_millis(OFFSET_MS.load(Ordering::SeqCst))
        }
        let rst = |conn: &mut H2Conn, stream: u32| {
            let mut wire = Vec::new();
            write_rst_stream(stream, ERR_CANCEL, &mut wire);
            conn.feed(&wire, &mut Vec::new()).close_after_write
        };
        let cfg = H2Config {
            max_rst_streams: 3,
            ..H2Config::default()
        };
        let mut conn = H2Conn::new(cfg);
        conn.clock = fake_now;
        let mut opening = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut opening);
        conn.feed(&opening, &mut Vec::new());
        // Three resets in each of many windows never trip the limit...
        for round in 0..5u64 {
            OFFSET_MS.store(round * 31_000, Ordering::SeqCst);
            for i in 0..3 {
                assert!(
                    !rst(&mut conn, (round as u32) * 10 + i * 2 + 1),
                    "round {round}"
                );
            }
        }
        // ...a fourth inside one window does.
        assert!(rst(&mut conn, 101));
    }

    #[test]
    fn h2_malformed_requests_are_reset_not_dispatched() {
        let request = |extra: &[(&str, &str)], body: Option<&[u8]>| {
            let mut conn = H2Conn::new(H2Config::default());
            let mut wire = CLIENT_PREFACE.to_vec();
            write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
            let mut block = vec![0x83, 0x84, 0x86];
            for (name, value) in extra {
                encode_header_pair(name, value.as_bytes(), &mut block);
            }
            let flags = FLAG_END_HEADERS | if body.is_none() { FLAG_END_STREAM } else { 0 };
            write_frame(FRAME_HEADERS, flags, 1, &block, &mut wire);
            if let Some(body) = body {
                write_frame(FRAME_DATA, FLAG_END_STREAM, 1, body, &mut wire);
            }
            let mut out = Vec::new();
            let res = conn.feed(&wire, &mut out);
            let reset = frames(&out).iter().any(|(ty, _, sid, payload)| {
                *ty == FRAME_RST_STREAM && *sid == 1 && payload == &ERR_PROTOCOL_ERROR.to_be_bytes()
            });
            (
                res.events.iter().any(|e| matches!(e, H2Event::Request(_))),
                reset,
                res.close_after_write,
            )
        };
        assert_eq!(
            request(&[("x-ok", "fine")], Some(b"")),
            (true, false, false)
        );
        for (label, extra, body) in [
            ("CR in value", vec![("x-a", "a\r\nx-b: 1")], None),
            ("LF in value", vec![("x-a", "a\nb")], None),
            ("NUL in value", vec![("x-a", "a\0b")], None),
            ("bad name", vec![("bad name", "v")], None),
            (
                "short body",
                vec![("content-length", "5")],
                Some(&b"abc"[..]),
            ),
            (
                "long body",
                vec![("content-length", "2")],
                Some(&b"abc"[..]),
            ),
            (
                "declared body, none sent",
                vec![("content-length", "5")],
                None,
            ),
            (
                "signed length",
                vec![("content-length", "+3")],
                Some(&b"abc"[..]),
            ),
            (
                "conflicting lengths",
                vec![("content-length", "3"), ("content-length", "4")],
                Some(&b"abc"[..]),
            ),
        ] {
            assert_eq!(request(&extra, body), (false, true, false), "{label}");
        }
        assert_eq!(
            request(&[("content-length", "3")], Some(b"abc")),
            (true, false, false)
        );
    }

    #[test]
    fn h2_hpack_table_follows_the_advertised_size_not_the_peers_setting() {
        let mut conn = H2Conn::new(H2Config::default());
        let mut wire = CLIENT_PREFACE.to_vec();
        // The peer says its own header table is 0 bytes; that governs what the server may encode with.
        write_frame(FRAME_SETTINGS, 0, 0, &[0, 1, 0, 0, 0, 0], &mut wire);
        // Stream 1 indexes x-token: v (dynamic entry 62); stream 3 refers back to it.
        let mut first = vec![0x82, 0x84, 0x86, 0x40];
        encode_hpack_str(b"x-token", &mut first);
        encode_hpack_str(b"v", &mut first);
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &first,
            &mut wire,
        );
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            3,
            &[0x82, 0x84, 0x86, 0xBE],
            &mut wire,
        );
        let res = conn.feed(&wire, &mut Vec::new());
        let requests: Vec<_> = res
            .events
            .iter()
            .filter_map(|e| match e {
                H2Event::Request(r) => Some(r),
                _ => None,
            })
            .collect();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .headers
            .iter()
            .any(|(k, v)| k == "x-token" && v == "v"));
        assert!(!res.close_after_write);

        // A size update above what the server advertised is a compression error.
        let mut conn = H2Conn::new(H2Config::default());
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        let mut block = vec![0x3F, 0xE2, 0x1F]; // dynamic table size update to 4097
        block.extend_from_slice(&[0x82, 0x84, 0x86]);
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &block,
            &mut wire,
        );
        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(res.close_after_write);
        assert!(frames(&out)
            .iter()
            .any(|(ty, _, _, p)| *ty == FRAME_GOAWAY
                && p[4..8] == ERR_COMPRESSION_ERROR.to_be_bytes()));
    }

    #[test]
    fn h2_non_utf8_target_resets_only_that_stream() {
        let mut conn = H2Conn::new(H2Config::default());
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        // Stream 1 indexes a good entry, then a target that is not UTF-8: table entries 63 and 62.
        let mut bad = vec![0x82, 0x86, 0x40];
        encode_hpack_str(b"x-ok", &mut bad);
        encode_hpack_str(b"1", &mut bad);
        // `:path`, literal with indexing (static name 4).
        bad.push(0x44);
        encode_hpack_str(&[b'/', 0xFF], &mut bad);
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &bad,
            &mut wire,
        );
        // Stream 3 refers to entry 63, which only resolves if the table stayed in step with the peer's
        // through the request that was refused.
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            3,
            &[0x82, 0x84, 0x86, 0xBF],
            &mut wire,
        );
        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(!res.close_after_write, "the connection survives");
        let resets: Vec<u32> = frames(&out)
            .iter()
            .filter(|(ty, _, _, _)| *ty == FRAME_RST_STREAM)
            .map(|(_, _, sid, _)| *sid)
            .collect();
        assert_eq!(resets, vec![1]);
        let served: Vec<&H2Request> = res
            .events
            .iter()
            .filter_map(|e| match e {
                H2Event::Request(r) => Some(r),
                _ => None,
            })
            .collect();
        assert_eq!(served.len(), 1);
        assert_eq!(served[0].stream_id, 3);
        assert!(served[0]
            .headers
            .iter()
            .any(|(k, v)| k == "x-ok" && v == "1"));
    }

    /// A `GET` header block with literal, unindexed fields after the pseudo-headers.
    fn get_block(path: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut block = vec![0x82, 0x86];
        let pseudo: [(&str, &[u8]); 2] = [(":path", path.as_bytes()), (":authority", b"a")];
        for (name, value) in pseudo.iter().chain(extra) {
            block.push(0x00);
            encode_hpack_str(name.as_bytes(), &mut block);
            encode_hpack_str(value, &mut block);
        }
        block
    }

    fn open_wire() -> (H2Conn, Vec<u8>) {
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        (H2Conn::new(H2Config::default()), wire)
    }

    fn requests(res: &H2FeedResult) -> Vec<&H2Request> {
        res.events
            .iter()
            .filter_map(|e| match e {
                H2Event::Request(r) => Some(r),
                _ => None,
            })
            .collect()
    }

    fn headers_frame(wire: &mut Vec<u8>, stream_id: u32, flags: u8, block: &[u8]) {
        write_frame(FRAME_HEADERS, flags, stream_id, block, wire);
    }

    const WHOLE: u8 = FLAG_END_HEADERS | FLAG_END_STREAM;

    #[test]
    fn h2_header_values_are_latin1() {
        let (mut conn, mut wire) = open_wire();
        headers_frame(
            &mut wire,
            1,
            WHOLE,
            &get_block("/", &[("x-raw", &[0xE9, 0xFF])]),
        );
        let res = conn.feed(&wire, &mut Vec::new());
        assert!(requests(&res)[0]
            .headers
            .iter()
            .any(|(k, v)| k == "x-raw" && v == "\u{e9}\u{ff}"));
    }

    #[test]
    fn h2_refuses_a_target_without_a_slash_and_a_second_host() {
        let (mut conn, mut wire) = open_wire();
        headers_frame(&mut wire, 1, WHOLE, &get_block("@evil.test/x", &[]));
        headers_frame(
            &mut wire,
            3,
            WHOLE,
            &get_block("/", &[("host", b"a"), ("host", b"b")]),
        );
        let res = conn.feed(&wire, &mut Vec::new());
        assert!(requests(&res).is_empty());
    }

    #[test]
    fn h2_host_validity_follows_the_host_field_the_url_uses() {
        let (mut conn, mut wire) = open_wire();
        headers_frame(
            &mut wire,
            1,
            WHOLE,
            &get_block("/", &[("host", b"evil.test/public?")]),
        );
        let res = conn.feed(&wire, &mut Vec::new());
        assert!(!requests(&res)[0].host_valid);
    }

    #[test]
    fn h2_resets_the_peer_provokes_are_counted() {
        let (mut conn, mut wire) = open_wire();
        for i in 0..300u32 {
            let id = 1 + i * 2;
            headers_frame(&mut wire, id, WHOLE, &get_block("/", &[]));
            write_frame(FRAME_WINDOW_UPDATE, 0, id, &[0; 4], &mut wire);
        }
        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(res.close_after_write);
        assert!(requests(&res).len() <= 101, "{}", requests(&res).len());
        assert!(frames(&out)
            .iter()
            .any(|(ty, _, _, p)| *ty == FRAME_GOAWAY
                && p[4..8] == ERR_ENHANCE_YOUR_CALM.to_be_bytes()));
    }

    #[test]
    fn h2_bounds_the_bodies_one_connection_holds() {
        let (mut conn, mut wire) = open_wire();
        let mut out = Vec::new();
        conn.feed(&wire, &mut out);
        let chunk = vec![0u8; DEFAULT_MAX_FRAME_SIZE];
        let mut held = 0usize;
        for i in 0..64u32 {
            let id = 1 + i * 2;
            wire.clear();
            headers_frame(&mut wire, id, FLAG_END_HEADERS, &get_block("/", &[]));
            for _ in 0..64 {
                write_frame(FRAME_DATA, 0, id, &chunk, &mut wire);
            }
            out.clear();
            conn.feed(&wire, &mut out);
            held = conn.active_streams.values().map(|st| st.body.len()).sum();
            assert!(held <= CONN_BODY_LIMIT);
        }
        assert!(held > CONN_BODY_LIMIT / 2);
    }

    #[test]
    fn h2_reports_output_stalled_behind_a_closed_window() {
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[0, 4, 0, 0, 0, 0], &mut wire);
        headers_frame(&mut wire, 1, WHOLE, &get_block("/", &[]));
        let mut conn = H2Conn::new(H2Config::default());
        let mut out = Vec::new();
        conn.feed(&wire, &mut out);
        assert!(conn.output_stalled_since().is_none());
        conn.write_response(1, 200, &[], Some(b"held"), &mut out);
        assert!(conn.output_stalled_since().is_some());
        let mut update = Vec::new();
        write_frame(FRAME_WINDOW_UPDATE, 0, 1, &16u32.to_be_bytes(), &mut update);
        conn.feed(&update, &mut out);
        assert!(conn.output_stalled_since().is_none());
    }

    #[test]
    fn h2_rapid_reset_triggers_goaway_enhance_your_calm() {
        let cfg = H2Config {
            max_rst_streams: 2,
            ..H2Config::default()
        };
        let mut conn = H2Conn::new(cfg);
        let mut wire = Vec::new();
        wire.extend_from_slice(CLIENT_PREFACE);
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        write_rst_stream(1, ERR_CANCEL, &mut wire);
        write_rst_stream(3, ERR_CANCEL, &mut wire);
        write_rst_stream(5, ERR_CANCEL, &mut wire);

        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(res.close_after_write);
        assert!(frames(&out)
            .iter()
            .any(|(ty, _, _, p)| *ty == FRAME_GOAWAY
                && p[4..8] == ERR_ENHANCE_YOUR_CALM.to_be_bytes()));
    }

    /// A connection that has read the preface and a SETTINGS frame, with the server's own output drained.
    fn ready_conn(cfg: H2Config) -> H2Conn {
        let mut conn = H2Conn::new(cfg);
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(FRAME_SETTINGS, 0, 0, &[], &mut wire);
        conn.feed(&wire, &mut Vec::new());
        conn
    }

    fn get_headers(extra: &[u8]) -> Vec<u8> {
        let mut block = vec![0x82, 0x84, 0x86];
        block.extend_from_slice(extra);
        block
    }

    #[test]
    fn h2_first_frame_must_be_the_client_settings() {
        let mut conn = H2Conn::new(H2Config::default());
        let mut wire = CLIENT_PREFACE.to_vec();
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &get_headers(&[]),
            &mut wire,
        );
        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(res.close_after_write);
        assert!(res.events.is_empty());
        assert!(frames(&out).iter().any(
            |(ty, _, _, p)| *ty == FRAME_GOAWAY && p[4..8] == ERR_PROTOCOL_ERROR.to_be_bytes()
        ));
    }

    #[test]
    fn h2_a_request_needs_exactly_one_scheme() {
        let attempt = |block: &[u8]| {
            let mut conn = ready_conn(H2Config::default());
            let mut wire = Vec::new();
            write_frame(
                FRAME_HEADERS,
                FLAG_END_HEADERS | FLAG_END_STREAM,
                1,
                block,
                &mut wire,
            );
            let mut out = Vec::new();
            let res = conn.feed(&wire, &mut out);
            let reset = frames(&out)
                .iter()
                .any(|(ty, _, sid, _)| *ty == FRAME_RST_STREAM && *sid == 1);
            (
                res.events.iter().any(|e| matches!(e, H2Event::Request(_))),
                reset,
            )
        };
        assert_eq!(attempt(&[0x82, 0x84, 0x86]), (true, false));
        assert_eq!(attempt(&[0x82, 0x84]), (false, true));
        assert_eq!(attempt(&[0x82, 0x84, 0x86, 0x87]), (false, true));
    }

    #[test]
    fn h2_trailers_with_a_pseudo_header_or_connection_field_reset_the_stream() {
        let attempt = |trailer: &[(&str, &str)]| {
            let mut conn = ready_conn(H2Config::default());
            let mut wire = Vec::new();
            write_frame(
                FRAME_HEADERS,
                FLAG_END_HEADERS,
                1,
                &get_headers(&[]),
                &mut wire,
            );
            write_frame(FRAME_DATA, 0, 1, b"abc", &mut wire);
            let mut block = Vec::new();
            for (name, value) in trailer {
                encode_header_pair(name, value.as_bytes(), &mut block);
            }
            write_frame(
                FRAME_HEADERS,
                FLAG_END_HEADERS | FLAG_END_STREAM,
                1,
                &block,
                &mut wire,
            );
            let mut out = Vec::new();
            let res = conn.feed(&wire, &mut out);
            let reset = frames(&out)
                .iter()
                .any(|(ty, _, sid, _)| *ty == FRAME_RST_STREAM && *sid == 1);
            (
                res.events.iter().any(|e| matches!(e, H2Event::Request(_))),
                reset,
                res.close_after_write,
            )
        };
        assert_eq!(attempt(&[("x-checksum", "1")]), (true, false, false));
        assert_eq!(attempt(&[(":path", "/other")]), (false, true, false));
        assert_eq!(attempt(&[("connection", "close")]), (false, true, false));
        assert_eq!(attempt(&[("x-a", "a\r\nb")]), (false, true, false));
    }

    /// A response that waits on flow control still counts toward the stream limit, so a peer that
    /// withholds credit cannot keep opening streams.
    #[test]
    fn h2_a_response_held_by_flow_control_still_counts_as_open() {
        let cfg = H2Config {
            max_concurrent_streams: 1,
            ..H2Config::default()
        };
        let mut conn = ready_conn(cfg);
        let mut wire = Vec::new();
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &get_headers(&[]),
            &mut wire,
        );
        let res = conn.feed(&wire, &mut Vec::new());
        assert!(res
            .events
            .iter()
            .any(|e| matches!(e, H2Event::Request(r) if r.stream_id == 1)));
        // A body larger than the initial 65,535-byte window cannot leave in one go.
        let body = vec![b'x'; 200_000];
        conn.write_response(1, 200, &[], Some(&body), &mut Vec::new());
        assert_eq!(conn.active_response_streams(), 1);

        let mut second = Vec::new();
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            3,
            &get_headers(&[]),
            &mut second,
        );
        let mut out = Vec::new();
        let res = conn.feed(&second, &mut out);
        assert!(!res.events.iter().any(|e| matches!(e, H2Event::Request(_))));
        assert!(frames(&out).iter().any(|(ty, _, sid, p)| {
            *ty == FRAME_RST_STREAM && *sid == 3 && p == &ERR_REFUSED_STREAM.to_be_bytes()
        }));
    }

    /// Credit granted before the response began is not lost: the response starts with it.
    #[test]
    fn h2_stream_credit_sent_before_the_response_is_kept() {
        let mut conn = ready_conn(H2Config::default());
        let mut wire = Vec::new();
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS | FLAG_END_STREAM,
            1,
            &get_headers(&[]),
            &mut wire,
        );
        write_frame(
            FRAME_WINDOW_UPDATE,
            0,
            1,
            &100_000u32.to_be_bytes(),
            &mut wire,
        );
        write_frame(
            FRAME_WINDOW_UPDATE,
            0,
            0,
            &100_000u32.to_be_bytes(),
            &mut wire,
        );
        conn.feed(&wire, &mut Vec::new());
        let body = vec![b'x'; 150_000];
        let mut out = Vec::new();
        conn.write_response(1, 200, &[], Some(&body), &mut out);
        let sent: usize = frames(&out)
            .iter()
            .filter(|(ty, _, sid, _)| *ty == FRAME_DATA && *sid == 1)
            .map(|(_, _, _, p)| p.len())
            .sum();
        assert_eq!(sent, 150_000);
        assert_eq!(conn.active_response_streams(), 0);
    }

    #[test]
    fn h2_an_unfinished_header_block_counts_toward_the_request_deadline() {
        let mut conn = ready_conn(H2Config::default());
        let mut wire = Vec::new();
        let mut out = Vec::new();
        write_frame(FRAME_HEADERS, 0, 1, &get_headers(&[]), &mut wire);
        conn.feed(&wire, &mut out);
        assert!(conn.oldest_incomplete_request().is_some());
    }

    #[test]
    fn h2_an_empty_scheme_resets_the_stream() {
        assert!(!is_uri_scheme(""));
        assert!(!is_uri_scheme("1http"));
        assert!(is_uri_scheme("coap+tcp"));
    }

    #[test]
    fn h2_held_response_bytes_are_bounded_per_connection() {
        let mut conn = ready_conn(H2Config::default());
        let mut out = Vec::new();
        let body = vec![0u8; CONN_BACKLOG_LIMIT];
        for id in [1u32, 3, 5] {
            conn.open_response_streams.insert(id, ());
            conn.write_response(id, 200, &[], Some(&body), &mut out);
        }
        assert!(conn.queued_response_bytes() <= CONN_BACKLOG_LIMIT * 2);
        // Streams 1 and 3 still owe bytes; 5, past the limit, was reset and holds none.
        assert_eq!(conn.active_response_streams(), 2);
        assert!(!conn.out_streams.contains_key(&5));
        let mut reset = Vec::new();
        write_rst_stream(5, ERR_ENHANCE_YOUR_CALM, &mut reset);
        assert!(out.ends_with(&reset));
    }

    #[test]
    fn h2_the_oldest_unfinished_request_is_reported_until_it_ends() {
        let mut conn = ready_conn(H2Config::default());
        assert!(conn.oldest_incomplete_request().is_none());
        let mut wire = Vec::new();
        write_frame(
            FRAME_HEADERS,
            FLAG_END_HEADERS,
            1,
            &get_headers(&[]),
            &mut wire,
        );
        conn.feed(&wire, &mut Vec::new());
        assert!(conn.oldest_incomplete_request().is_some());
        let mut end = Vec::new();
        write_frame(FRAME_DATA, FLAG_END_STREAM, 1, &[], &mut end);
        conn.feed(&end, &mut Vec::new());
        assert!(conn.oldest_incomplete_request().is_none());
    }
}
