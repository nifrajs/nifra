//! RFC 6455 WebSocket handshake, sans-I/O framing, fragmentation reassembly,
//! per-route payload cap enforcement, and peer close-reason propagation.

pub use fastwebsockets::{Frame, OpCode, Payload};
pub use flate2::Compress;
use flate2::{Compression, Decompress, FlushCompress, FlushDecompress, Status};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFLATE_TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

pub const OPCODE_CONT: u8 = 0x0;
pub const OPCODE_TEXT: u8 = 0x1;
pub const OPCODE_BINARY: u8 = 0x2;
pub const OPCODE_CLOSE: u8 = 0x8;
pub const OPCODE_PING: u8 = 0x9;
pub const OPCODE_PONG: u8 = 0xA;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WsDeflateConfig {
    pub enabled: bool,
    pub server_no_context_takeover: bool,
    pub client_no_context_takeover: bool,
    pub server_max_window_bits: u8,
    pub client_max_window_bits: u8,
    pub threshold: usize,
    /// Hard upper bound on inflated message bytes (protection against zip bombs). `0` inherits
    /// `max_message_size`.
    pub max_decompressed_size: usize,
    pub level: u8,
    pub shared_compressor: bool,
}

impl Default for WsDeflateConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server_no_context_takeover: false,
            client_no_context_takeover: false,
            server_max_window_bits: 15,
            client_max_window_bits: 15,
            threshold: 0,
            max_decompressed_size: 0,
            level: 6,
            shared_compressor: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegotiatedDeflate {
    pub header_value: String,
    pub server_no_context_takeover: bool,
    pub client_no_context_takeover: bool,
    pub server_max_window_bits: u8,
    pub client_max_window_bits: u8,
    pub threshold: usize,
    pub max_decompressed_size: usize,
    pub level: u8,
    pub shared_compressor: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct WsConfig {
    pub max_message_size: usize,
    pub backpressure_limit: usize,
    pub deflate: WsDeflateConfig,
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            max_message_size: 16 * 1024 * 1024,
            backpressure_limit: 1024 * 1024,
            deflate: WsDeflateConfig::default(),
        }
    }
}

/// Structured close event that preserves the peer's close reason string (RFC 6455 §5.5.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsCloseInfo {
    pub code: u16,
    pub reason: String,
}

/// Decode an RFC 6455 close frame payload into `(code, reason)`.
pub fn parse_close_payload(payload: &[u8]) -> WsCloseInfo {
    if payload.len() < 2 {
        return WsCloseInfo {
            code: 1005,
            reason: String::new(),
        };
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    let reason = std::str::from_utf8(&payload[2..]).unwrap_or("").to_owned();
    WsCloseInfo { code, reason }
}

/// RFC 6455 §7.4: a close code a peer may put on the wire. 1004-1006 and 1015 are reserved for local
/// use, and 1016-2999 and above 4999 are unassigned.
pub fn is_valid_close_code(code: u16) -> bool {
    matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999)
}

/// Decode a close frame payload the way a server must accept it: an empty body, or a valid code with
/// a UTF-8 reason. On refusal, the close code to fail the connection with (1002 or 1007).
pub fn try_parse_close_payload(payload: &[u8]) -> Result<WsCloseInfo, u16> {
    match payload.len() {
        0 => Ok(WsCloseInfo {
            code: 1005,
            reason: String::new(),
        }),
        1 => Err(1002),
        _ => {
            let code = u16::from_be_bytes([payload[0], payload[1]]);
            if !is_valid_close_code(code) {
                return Err(1002);
            }
            let reason = std::str::from_utf8(&payload[2..]).map_err(|_| 1007u16)?;
            Ok(WsCloseInfo {
                code,
                reason: reason.to_owned(),
            })
        }
    }
}

#[inline]
pub fn exceeds_payload_cap(len: usize, cap: usize) -> bool {
    len > cap
}

/// Validate RFC 6455 §4.2.1 WebSocket upgrade headers and return the trimmed `Sec-WebSocket-Key`.
pub fn validate_upgrade_headers<'a>(
    connection: Option<&str>,
    upgrade: Option<&str>,
    version: Option<&str>,
    key: Option<&'a str>,
) -> Option<&'a str> {
    let upgrade = upgrade?.trim();
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return None;
    }
    let connection = connection?;
    let has_upgrade_token = connection
        .split(',')
        .any(|tok| tok.trim().eq_ignore_ascii_case("upgrade"));
    if !has_upgrade_token {
        return None;
    }
    if version?.trim() != "13" {
        return None;
    }
    let key = key?.trim();
    is_nonce_key(key).then_some(key)
}

/// A `Sec-WebSocket-Key`: the base64 of a 16-byte nonce, which is 22 characters and `==`, the last
/// character carrying two bits and four zero pad bits.
fn is_nonce_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.len() != 24 || !key.ends_with("==") {
        return false;
    }
    let sextet = |b: u8| match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    bytes[..22].iter().all(|&b| sextet(b).is_some())
        && sextet(bytes[21]).is_some_and(|last| last & 0x0f == 0)
}

/// Compute RFC 6455 §4.2.2 `Sec-WebSocket-Accept` from a client's `Sec-WebSocket-Key`.
pub fn compute_accept_key(key: &str) -> String {
    let mut input = Vec::with_capacity(key.len() + WS_GUID.len());
    input.extend_from_slice(key.as_bytes());
    input.extend_from_slice(WS_GUID.as_bytes());
    let digest = sha1(&input);
    base64_encode(&digest)
}

/// Write an HTTP/1.1 `101 Switching Protocols` WebSocket handshake response with optional
/// `Sec-WebSocket-Extensions`.
pub fn write_upgrade_response_with_extensions(
    accept_key: &str,
    extensions: Option<&str>,
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ",
    );
    out.extend_from_slice(accept_key.as_bytes());
    if let Some(ext) = extensions {
        out.extend_from_slice(b"\r\nSec-WebSocket-Extensions: ");
        out.extend_from_slice(ext.as_bytes());
    }
    out.extend_from_slice(b"\r\n\r\n");
}

/// Write an HTTP/1.1 `101 Switching Protocols` WebSocket handshake response.
pub fn write_upgrade_response(accept_key: &str, out: &mut Vec<u8>) {
    write_upgrade_response_with_extensions(accept_key, None, out);
}

fn parse_window_bits(raw: &str) -> Option<u8> {
    let trimmed = raw.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    let val: u8 = unquoted.parse().ok()?;
    (8..=15).contains(&val).then_some(val)
}

/// Negotiate an RFC 7692 `permessage-deflate` offer from `Sec-WebSocket-Extensions`.
pub fn negotiate_permessage_deflate(
    header: Option<&str>,
    cfg: WsDeflateConfig,
) -> Option<NegotiatedDeflate> {
    if !cfg.enabled {
        return None;
    }
    let header = header?;
    let cfg_server_bits = cfg.server_max_window_bits.clamp(8, 15);
    let cfg_client_bits = cfg.client_max_window_bits.clamp(8, 15);

    for offer in header.split(',') {
        let mut parts = offer.split(';').map(str::trim).filter(|s| !s.is_empty());
        let Some(name) = parts.next() else {
            continue;
        };
        if !name.eq_ignore_ascii_case("permessage-deflate") {
            continue;
        }

        let mut seen_snc = false;
        let mut seen_cnc = false;
        let mut seen_smwb = false;
        let mut seen_cmwb = false;
        let mut req_smwb: Option<u8> = None;
        let mut req_cmwb: Option<Option<u8>> = None;
        let mut valid = true;

        for param in parts {
            let (k, v) = match param.split_once('=') {
                Some((k, v)) => (k.trim(), Some(v.trim())),
                None => (param, None),
            };
            if k.eq_ignore_ascii_case("server_no_context_takeover") {
                if seen_snc || v.is_some() {
                    valid = false;
                    break;
                }
                seen_snc = true;
            } else if k.eq_ignore_ascii_case("client_no_context_takeover") {
                if seen_cnc || v.is_some() {
                    valid = false;
                    break;
                }
                seen_cnc = true;
            } else if k.eq_ignore_ascii_case("server_max_window_bits") {
                if seen_smwb {
                    valid = false;
                    break;
                }
                let Some(bits) = v.and_then(parse_window_bits) else {
                    valid = false;
                    break;
                };
                seen_smwb = true;
                req_smwb = Some(bits);
            } else if k.eq_ignore_ascii_case("client_max_window_bits") {
                if seen_cmwb {
                    valid = false;
                    break;
                }
                seen_cmwb = true;
                match v {
                    None => req_cmwb = Some(None),
                    Some(raw) => {
                        let Some(bits) = parse_window_bits(raw) else {
                            valid = false;
                            break;
                        };
                        req_cmwb = Some(Some(bits));
                    }
                }
            } else {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }

        // RFC 7692 §7.1.2.2: server cannot limit client window bits below 15 unless the client
        // explicitly included `client_max_window_bits` in its offer.
        let client_bits = match req_cmwb {
            None => {
                if cfg_client_bits < 15 {
                    continue;
                }
                15
            }
            Some(None) => cfg_client_bits,
            Some(Some(bits)) => cfg_client_bits.min(bits),
        };
        let server_bits = match req_smwb {
            Some(bits) => cfg_server_bits.min(bits),
            None => cfg_server_bits,
        };
        let snc = seen_snc || cfg.server_no_context_takeover || cfg.shared_compressor;
        let cnc = seen_cnc || cfg.client_no_context_takeover;

        let mut header_value = String::from("permessage-deflate");
        if snc {
            header_value.push_str("; server_no_context_takeover");
        }
        if cnc {
            header_value.push_str("; client_no_context_takeover");
        }
        if server_bits < 15 || req_smwb.is_some() {
            header_value.push_str(&format!("; server_max_window_bits={server_bits}"));
        }
        if matches!(req_cmwb, Some(Some(_))) || (matches!(req_cmwb, Some(None)) && client_bits < 15)
        {
            header_value.push_str(&format!("; client_max_window_bits={client_bits}"));
        }

        return Some(NegotiatedDeflate {
            header_value,
            server_no_context_takeover: snc,
            client_no_context_takeover: cnc,
            server_max_window_bits: server_bits,
            client_max_window_bits: client_bits,
            threshold: cfg.threshold,
            max_decompressed_size: cfg.max_decompressed_size,
            level: cfg.level.clamp(1, 9),
            shared_compressor: cfg.shared_compressor,
        });
    }
    None
}

/// Write an unmasked server-to-client RFC 6455 frame with optional RSV1 bit (`permessage-deflate`).
pub fn write_server_frame_rsv(opcode: u8, rsv1: bool, payload: &[u8], out: &mut Vec<u8>) {
    let rsv_bit = if rsv1 { 0x40 } else { 0 };
    out.push(0x80 | rsv_bit | (opcode & 0x0F));
    let len = payload.len();
    if len < 126 {
        out.push(len as u8);
    } else if len <= u16::MAX as usize {
        out.push(126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
}

/// Write an unmasked server-to-client RFC 6455 frame.
pub fn write_server_frame(opcode: u8, payload: &[u8], out: &mut Vec<u8>) {
    write_server_frame_rsv(opcode, false, payload, out);
}

/// Write an unmasked server-to-client RFC 6455 Close frame with `(code, reason)`.
pub fn write_close_frame(code: u16, reason: &str, out: &mut Vec<u8>) {
    // A control frame carries at most 125 bytes: the code, then the reason cut on a character boundary.
    let mut end = reason.len().min(123);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    let capped = &reason.as_bytes()[..end];
    let mut payload = Vec::with_capacity(2 + capped.len());
    payload.extend_from_slice(&code.to_be_bytes());
    payload.extend_from_slice(capped);
    write_server_frame(OPCODE_CLOSE, &payload, out);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEvent {
    Text(String),
    Binary(Vec<u8>),
    Close { code: u16, reason: String },
}

#[derive(Debug, Default)]
pub struct WsFeedResult {
    pub consumed: usize,
    pub events: Vec<WsEvent>,
    pub close_after_write: bool,
}

pub struct WsDeflateState {
    compress: Option<Compress>,
    decompress: Decompress,
    server_no_context_takeover: bool,
    client_no_context_takeover: bool,
    threshold: usize,
    max_decompressed_size: usize,
    shared_compressor: bool,
}

impl std::fmt::Debug for WsDeflateState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsDeflateState")
            .field(
                "server_no_context_takeover",
                &self.server_no_context_takeover,
            )
            .field(
                "client_no_context_takeover",
                &self.client_no_context_takeover,
            )
            .field("threshold", &self.threshold)
            .field("max_decompressed_size", &self.max_decompressed_size)
            .field("shared_compressor", &self.shared_compressor)
            .finish_non_exhaustive()
    }
}

/// Create a raw-deflate compressor configured for shared stateless PMCE reuse (`window_bits` 9..=15).
pub fn new_shared_compressor(level: u8, window_bits: u8) -> Compress {
    Compress::new_with_window_bits(
        Compression::new(u32::from(level.clamp(1, 9))),
        false,
        window_bits.clamp(9, 15),
    )
}

/// Compress `payload` with RFC 7692 `Z_SYNC_FLUSH`, removing the trailing `0x00 0x00 0xff 0xff`.
pub fn compress_deflate_payload(compress: &mut Compress, payload: &[u8], out: &mut Vec<u8>) {
    let mut off = 0usize;
    let mut tmp = [0u8; 4096];
    let start_len = out.len();
    loop {
        let before_in = compress.total_in();
        let before_out = compress.total_out();
        let status = compress.compress(&payload[off..], &mut tmp, FlushCompress::Sync);
        let in_delta = (compress.total_in() - before_in) as usize;
        let out_delta = (compress.total_out() - before_out) as usize;
        off += in_delta;
        if out_delta > 0 {
            out.extend_from_slice(&tmp[..out_delta]);
        }
        match status {
            Ok(Status::Ok) | Ok(Status::BufError) => {
                if off >= payload.len() && out_delta < tmp.len() {
                    break;
                }
                if in_delta == 0 && out_delta == 0 {
                    break;
                }
            }
            Ok(Status::StreamEnd) | Err(_) => break,
        }
    }
    let written = out.len() - start_len;
    if written >= 4 && out[out.len() - 4..] == DEFLATE_TAIL {
        out.truncate(out.len() - 4);
    }
}

fn decompress_deflate_payload(
    decompress: &mut Decompress,
    payload: &[u8],
    max_out: usize,
) -> Result<Vec<u8>, u16> {
    let mut out = Vec::with_capacity(payload.len().saturating_mul(2).min(max_out).min(64 * 1024));
    let mut tmp = [0u8; 8192];
    let mut stream_ended = false;

    for &(seg, flush) in &[
        (payload, FlushDecompress::None),
        (&DEFLATE_TAIL[..], FlushDecompress::Sync),
    ] {
        let mut off = 0usize;
        loop {
            let before_in = decompress.total_in();
            let before_out = decompress.total_out();
            let avail = max_out.saturating_sub(out.len());
            // Leave room for at least 1 byte so output exceeding `max_out` is caught before OOM.
            let slice_cap = if avail == 0 { 1 } else { avail.min(tmp.len()) };
            let status = decompress
                .decompress(&seg[off..], &mut tmp[..slice_cap], flush)
                .map_err(|_| 1002u16)?;
            let in_delta = (decompress.total_in() - before_in) as usize;
            let out_delta = (decompress.total_out() - before_out) as usize;
            off += in_delta;

            if out.len().saturating_add(out_delta) > max_out {
                return Err(1009);
            }
            if out_delta > 0 {
                out.extend_from_slice(&tmp[..out_delta]);
            }
            match status {
                Status::StreamEnd => {
                    stream_ended = true;
                    break;
                }
                Status::Ok | Status::BufError => {
                    if off >= seg.len() && out_delta < slice_cap {
                        break;
                    }
                    if in_delta == 0 && out_delta == 0 {
                        break;
                    }
                }
            }
        }
        if stream_ended {
            break;
        }
    }
    if stream_ended {
        decompress.reset(false);
    }
    Ok(out)
}

/// Sans-I/O RFC 6455 server-side WebSocket connection state machine.
#[derive(Debug)]
pub struct WsConn {
    max_message_size: usize,
    frag_opcode: Option<u8>,
    frag_compressed: bool,
    frag_buf: Vec<u8>,
    deflate: Option<WsDeflateState>,
    close_sent: bool,
    closed: bool,
}

impl WsConn {
    pub fn new(max_message_size: usize) -> Self {
        Self::with_deflate(max_message_size, None)
    }

    pub fn with_deflate(max_message_size: usize, negotiated: Option<&NegotiatedDeflate>) -> Self {
        let deflate = negotiated.map(|n| WsDeflateState {
            compress: if n.shared_compressor {
                None
            } else {
                Some(Compress::new_with_window_bits(
                    Compression::new(u32::from(n.level)),
                    false,
                    n.server_max_window_bits.max(9),
                ))
            },
            decompress: Decompress::new_with_window_bits(false, n.client_max_window_bits.max(9)),
            server_no_context_takeover: n.server_no_context_takeover,
            client_no_context_takeover: n.client_no_context_takeover,
            threshold: n.threshold,
            max_decompressed_size: if n.max_decompressed_size > 0 {
                n.max_decompressed_size
            } else {
                max_message_size
            },
            shared_compressor: n.shared_compressor,
        });
        Self {
            max_message_size,
            frag_opcode: None,
            frag_compressed: false,
            frag_buf: Vec::new(),
            deflate,
            close_sent: false,
            closed: false,
        }
    }

    /// Encode an outgoing text/binary message, applying RFC 7692 compression when negotiated and
    /// above `threshold`. Pass `shared_compress` when `shared_compressor: true` is active.
    pub fn encode_server_message(
        &mut self,
        opcode: u8,
        payload: &[u8],
        shared_compress: Option<&mut Compress>,
        out: &mut Vec<u8>,
    ) {
        if let Some(ref mut d) = self.deflate {
            if payload.len() >= d.threshold {
                let comp_opt = if d.shared_compressor {
                    shared_compress
                } else {
                    d.compress.as_mut()
                };
                if let Some(comp) = comp_opt {
                    let mut compressed = Vec::with_capacity(payload.len().min(4096) + 16);
                    compress_deflate_payload(comp, payload, &mut compressed);
                    if d.server_no_context_takeover || d.shared_compressor {
                        comp.reset();
                    }
                    write_server_frame_rsv(opcode, true, &compressed, out);
                    return;
                }
            }
        }
        write_server_frame_rsv(opcode, false, payload, out);
    }

    pub fn mark_close_sent(&mut self) {
        self.close_sent = true;
        // A half-received message is never delivered, and must not count against later frames.
        self.frag_opcode = None;
        self.frag_compressed = false;
        self.frag_buf = Vec::new();
    }

    pub fn close_sent(&self) -> bool {
        self.close_sent
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Feed raw bytes from the TCP/TLS read buffer into the WebSocket frame decoder.
    /// Any automatic protocol replies (Pong, Close) are appended to `write_buf`.
    pub fn feed(&mut self, buf: &[u8], write_buf: &mut Vec<u8>) -> WsFeedResult {
        let mut res = WsFeedResult::default();
        if self.closed {
            res.consumed = buf.len();
            res.close_after_write = true;
            return res;
        }

        let mut pos = 0usize;
        while pos < buf.len() {
            let rem = &buf[pos..];
            if rem.len() < 2 {
                break;
            }
            let b0 = rem[0];
            let b1 = rem[1];
            let fin = (b0 & 0x80) != 0;
            let rsv = b0 & 0x70;
            let opcode = b0 & 0x0F;
            let masked = (b1 & 0x80) != 0;
            let len7 = (b1 & 0x7F) as usize;
            let is_control = (opcode & 0x08) != 0;

            let rsv1 = (rsv & 0x40) != 0;
            let bad_rsv = if is_control || self.deflate.is_none() || opcode == OPCODE_CONT {
                rsv != 0
            } else {
                (rsv & 0x30) != 0
            };

            // RFC 6455 §5.2 & RFC 7692 §6: reserved bits must be 0 except RSV1 on first data frame
            // when `permessage-deflate` was negotiated; client frames MUST be masked.
            if bad_rsv || !masked {
                self.fail_protocol(1002, "protocol error", write_buf, &mut res, buf.len());
                return res;
            }

            if is_control && (!fin || len7 > 125) {
                self.fail_protocol(1002, "protocol error", write_buf, &mut res, buf.len());
                return res;
            }

            let (payload_len, mut hdr_len) = match len7 {
                0..=125 => (len7, 2usize),
                126 => {
                    if rem.len() < 4 {
                        break;
                    }
                    let wide = u16::from_be_bytes([rem[2], rem[3]]) as usize;
                    // RFC 6455 §5.2: the shortest length form that holds the payload.
                    if wide < 126 {
                        self.fail_protocol(1002, "protocol error", write_buf, &mut res, buf.len());
                        return res;
                    }
                    (wide, 4usize)
                }
                127 => {
                    if rem.len() < 10 {
                        break;
                    }
                    let raw64 = u64::from_be_bytes([
                        rem[2], rem[3], rem[4], rem[5], rem[6], rem[7], rem[8], rem[9],
                    ]);
                    if (raw64 >> 63) != 0 || raw64 < 65_536 {
                        self.fail_protocol(1002, "protocol error", write_buf, &mut res, buf.len());
                        return res;
                    }
                    (raw64 as usize, 10usize)
                }
                _ => unreachable!(),
            };

            // Enforce payload cap immediately before waiting for an oversized body.
            if !is_control {
                let total_len = self.frag_buf.len().saturating_add(payload_len);
                if exceeds_payload_cap(total_len, self.max_message_size) {
                    self.fail_protocol(1009, "message too large", write_buf, &mut res, buf.len());
                    return res;
                }
            }

            let mask_offset = hdr_len;
            hdr_len += 4;
            let Some(frame_end) = hdr_len.checked_add(payload_len) else {
                self.fail_protocol(1009, "message too large", write_buf, &mut res, buf.len());
                return res;
            };
            if rem.len() < frame_end {
                break;
            }

            let mask = [
                rem[mask_offset],
                rem[mask_offset + 1],
                rem[mask_offset + 2],
                rem[mask_offset + 3],
            ];
            let mut payload = rem[hdr_len..frame_end].to_vec();
            apply_mask(&mut payload, mask);
            pos += frame_end;

            match opcode {
                OPCODE_PING => {
                    write_server_frame(OPCODE_PONG, &payload, write_buf);
                }
                OPCODE_PONG => {}
                OPCODE_CLOSE => {
                    let info = match try_parse_close_payload(&payload) {
                        Ok(info) => info,
                        Err(code) => {
                            let reason = if code == 1007 {
                                "invalid utf-8"
                            } else {
                                "protocol error"
                            };
                            self.fail_protocol(code, reason, write_buf, &mut res, pos);
                            return res;
                        }
                    };
                    if !self.close_sent {
                        let reply_code = if info.code == 1005 { 1000 } else { info.code };
                        write_close_frame(reply_code, &info.reason, write_buf);
                        self.close_sent = true;
                    }
                    self.closed = true;
                    res.events.push(WsEvent::Close {
                        code: info.code,
                        reason: info.reason,
                    });
                    res.consumed = pos;
                    res.close_after_write = true;
                    return res;
                }
                // After this side sent Close nothing more is delivered; Ping and the peer's Close
                // still run so the closing handshake can finish.
                OPCODE_TEXT | OPCODE_BINARY | OPCODE_CONT if self.close_sent => {}
                OPCODE_TEXT | OPCODE_BINARY => {
                    if self.frag_opcode.is_some() {
                        self.fail_protocol(1002, "protocol error", write_buf, &mut res, pos);
                        return res;
                    }
                    if fin {
                        if !self.emit_message(opcode, rsv1, payload, write_buf, &mut res, pos) {
                            return res;
                        }
                    } else {
                        self.frag_opcode = Some(opcode);
                        self.frag_compressed = rsv1;
                        self.frag_buf = payload;
                    }
                }
                OPCODE_CONT => {
                    let Some(orig_op) = self.frag_opcode else {
                        self.fail_protocol(1002, "protocol error", write_buf, &mut res, pos);
                        return res;
                    };
                    self.frag_buf.extend_from_slice(&payload);
                    if fin {
                        let op = orig_op;
                        let compressed = self.frag_compressed;
                        self.frag_opcode = None;
                        self.frag_compressed = false;
                        let full = std::mem::take(&mut self.frag_buf);
                        if !self.emit_message(op, compressed, full, write_buf, &mut res, pos) {
                            return res;
                        }
                    }
                }
                _ => {
                    self.fail_protocol(1002, "protocol error", write_buf, &mut res, pos);
                    return res;
                }
            }
        }

        res.consumed = pos;
        res
    }

    fn emit_message(
        &mut self,
        opcode: u8,
        compressed: bool,
        mut payload: Vec<u8>,
        write_buf: &mut Vec<u8>,
        res: &mut WsFeedResult,
        consumed: usize,
    ) -> bool {
        if compressed {
            let Some(ref mut d) = self.deflate else {
                self.fail_protocol(1002, "protocol error", write_buf, res, consumed);
                return false;
            };
            match decompress_deflate_payload(&mut d.decompress, &payload, d.max_decompressed_size) {
                Ok(inflated) => {
                    if d.client_no_context_takeover {
                        d.decompress.reset(false);
                    }
                    payload = inflated;
                }
                Err(1009) => {
                    self.fail_protocol(1009, "message too large", write_buf, res, consumed);
                    return false;
                }
                Err(code) => {
                    self.fail_protocol(
                        code,
                        "invalid compressed payload",
                        write_buf,
                        res,
                        consumed,
                    );
                    return false;
                }
            }
        }
        if opcode == OPCODE_TEXT {
            match String::from_utf8(payload) {
                Ok(text) => {
                    res.events.push(WsEvent::Text(text));
                    true
                }
                Err(_) => {
                    self.fail_protocol(1007, "invalid utf-8", write_buf, res, consumed);
                    false
                }
            }
        } else {
            res.events.push(WsEvent::Binary(payload));
            true
        }
    }

    fn fail_protocol(
        &mut self,
        code: u16,
        reason: &str,
        write_buf: &mut Vec<u8>,
        res: &mut WsFeedResult,
        consumed: usize,
    ) {
        if !self.close_sent {
            write_close_frame(code, reason, write_buf);
            self.close_sent = true;
        }
        self.closed = true;
        res.events.push(WsEvent::Close {
            code,
            reason: reason.to_owned(),
        });
        res.consumed = consumed;
        res.close_after_write = true;
    }
}

#[inline]
fn apply_mask(data: &mut [u8], mask: [u8; 4]) {
    for (i, b) in data.iter_mut().enumerate() {
        *b ^= mask[i & 3];
    }
}

/// Pure-Rust SHA-1 (FIPS 180-4) used exclusively for RFC 6455 `Sec-WebSocket-Accept`.
fn sha1(input: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (input.len() as u64) * 8;
    let mut msg = Vec::with_capacity(input.len() + 72);
    msg.extend_from_slice(input);
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 80];
    for chunk in msg.chunks_exact(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h0, h1, h2, h3, h4);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_client_frame(fin: bool, opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push((if fin { 0x80 } else { 0 }) | (opcode & 0x0F));
        let len = payload.len();
        if len < 126 {
            out.push(0x80 | (len as u8));
        } else if len <= u16::MAX as usize {
            out.push(0x80 | 126);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            out.push(0x80 | 127);
            out.extend_from_slice(&(len as u64).to_be_bytes());
        }
        out.extend_from_slice(&mask);
        let mut masked = payload.to_vec();
        apply_mask(&mut masked, mask);
        out.extend_from_slice(&masked);
        out
    }

    #[test]
    fn a_handshake_key_is_a_base64_sixteen_byte_nonce() {
        let accepted = |key: &str| {
            validate_upgrade_headers(Some("Upgrade"), Some("websocket"), Some("13"), Some(key))
                .is_some()
        };
        assert!(accepted("dGhlIHNhbXBsZSBub25jZQ=="));
        // 24 characters, but not base64, not a 16-byte nonce, or with stray pad bits.
        assert!(!accepted("!!!!!!!!!!!!!!!!!!!!!!=="));
        assert!(!accepted("dGhlIHNhbXBsZSBub25jZQ=A"));
        assert!(!accepted("dGhlIHNhbXBsZSBub25jZR=="));
        assert!(!accepted("dGhlIHNhbXBsZSBub25jZQ"));
    }

    #[test]
    fn a_length_is_sent_in_its_shortest_form() {
        let feed = |frame: Vec<u8>| {
            let mut conn = WsConn::new(1 << 20);
            let mut out = Vec::new();
            let res = conn.feed(&frame, &mut out);
            let delivered = res
                .events
                .iter()
                .filter(|e| !matches!(e, WsEvent::Close { .. }))
                .count();
            (delivered, res.close_after_write)
        };
        let mask = [1, 2, 3, 4];
        // One byte in the 16-bit form.
        let mut wide = vec![0x81, 0x80 | 126, 0, 1];
        wide.extend_from_slice(&mask);
        wide.push(b'x' ^ mask[0]);
        assert_eq!(feed(wide), (0, true));
        // 126 bytes is the smallest the 16-bit form may carry.
        assert_eq!(
            feed(make_client_frame(true, OPCODE_TEXT, &[b'x'; 126], mask)),
            (1, false)
        );
        // 65,535 bytes in the 64-bit form.
        let mut huge = vec![0x81, 0x80 | 127];
        huge.extend_from_slice(&65_535u64.to_be_bytes());
        huge.extend_from_slice(&mask);
        huge.extend_from_slice(&[0u8; 65_535]);
        assert_eq!(feed(huge), (0, true));
        assert_eq!(
            feed(make_client_frame(true, OPCODE_TEXT, &[b'x'; 65_536], mask)),
            (1, false)
        );
    }

    #[test]
    fn nothing_is_delivered_after_this_side_sent_close() {
        let mut conn = WsConn::new(1024);
        conn.mark_close_sent();
        let mask = [5, 6, 7, 8];
        let mut wire = make_client_frame(true, OPCODE_TEXT, b"late", mask);
        wire.extend(make_client_frame(false, OPCODE_BINARY, b"a", mask));
        wire.extend(make_client_frame(true, OPCODE_CONT, b"b", mask));
        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert!(res.events.is_empty());
        assert!(!res.close_after_write);
        // The peer's Close still ends it.
        let res = conn.feed(
            &make_client_frame(true, OPCODE_CLOSE, &1000u16.to_be_bytes(), mask),
            &mut out,
        );
        assert!(res.close_after_write);
        assert!(matches!(
            res.events.last(),
            Some(WsEvent::Close { code: 1000, .. })
        ));
    }

    #[test]
    fn a_fragment_held_at_close_does_not_count_against_later_frames() {
        let mut conn = WsConn::new(8);
        let mask = [1, 2, 3, 4];
        let mut out = Vec::new();
        conn.feed(
            &make_client_frame(false, OPCODE_BINARY, b"123456", mask),
            &mut out,
        );
        conn.mark_close_sent();
        let mut wire = make_client_frame(true, OPCODE_CONT, b"78", mask);
        wire.extend(make_client_frame(true, OPCODE_TEXT, b"abc", mask));
        let res = conn.feed(&wire, &mut out);
        assert!(!res.close_after_write);
        assert!(res.events.is_empty());
    }

    #[test]
    fn a_nonce_with_set_padding_bits_is_refused() {
        assert!(is_nonce_key("dGhlIHNhbXBsZSBub25jZQ=="));
        assert!(!is_nonce_key("dGhlIHNhbXBsZSBub25jZU=="));
    }

    #[test]
    fn preserves_peer_close_reason() {
        let mut payload = Vec::new();
        payload.extend_from_slice(&1001u16.to_be_bytes());
        payload.extend_from_slice(b"going away");
        let info = parse_close_payload(&payload);
        assert_eq!(info.code, 1001);
        assert_eq!(info.reason, "going away");
    }

    #[test]
    fn refuses_invalid_close_codes_and_reasons() {
        let close = |payload: &[u8]| {
            let mut conn = WsConn::new(1024);
            let mut out = Vec::new();
            let res = conn.feed(
                &make_client_frame(true, OPCODE_CLOSE, payload, [9, 8, 7, 6]),
                &mut out,
            );
            let sent = u16::from_be_bytes([out[2], out[3]]);
            (res.close_after_write, sent)
        };
        let with_code = |code: u16, reason: &[u8]| {
            let mut payload = code.to_be_bytes().to_vec();
            payload.extend_from_slice(reason);
            payload
        };
        // Valid: echoed back.
        assert_eq!(close(&with_code(1000, b"bye")), (true, 1000));
        assert_eq!(close(&with_code(3000, b"")), (true, 3000));
        assert_eq!(close(&with_code(4999, b"")), (true, 4999));
        // No code at all is answered with a normal close.
        assert_eq!(close(&[]), (true, 1000));
        // Codes that must never be sent, or that nobody assigned.
        for code in [0u16, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000] {
            assert_eq!(close(&with_code(code, b"")), (true, 1002), "{code}");
        }
        // A reason that is not UTF-8.
        assert_eq!(close(&with_code(1000, &[0xFF, 0xFE])), (true, 1007));
        assert_eq!(close(&[0x03]), (true, 1002));
    }

    #[test]
    fn close_reasons_are_cut_on_character_boundaries() {
        // 61 two-byte characters plus one: 123 is inside the 62nd character.
        let reason = format!("{}\u{e9}", "a".repeat(121));
        let mut out = Vec::new();
        write_close_frame(1000, &reason, &mut out);
        let payload_len = out[1] as usize;
        let reason_bytes = &out[2 + 2..2 + payload_len];
        assert!(std::str::from_utf8(reason_bytes).is_ok());
        assert!(payload_len <= 125);
        let mut out = Vec::new();
        write_close_frame(1000, &"\u{1F600}".repeat(40), &mut out);
        assert!(std::str::from_utf8(&out[4..2 + out[1] as usize]).is_ok());
    }

    #[test]
    fn computes_rfc6455_accept_key() {
        let key = validate_upgrade_headers(
            Some("keep-alive, Upgrade"),
            Some("websocket"),
            Some("13"),
            Some("dGhlIHNhbXBsZSBub25jZQ=="),
        )
        .expect("valid handshake");
        assert_eq!(compute_accept_key(key), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert!(validate_upgrade_headers(
            Some("Upgrade"),
            Some("websocket"),
            Some("8"),
            Some("dGhlIHNhbXBsZSBub25jZQ=="),
        )
        .is_none());
    }

    #[test]
    fn decodes_fragmented_text_ping_pong_and_close() {
        let mut conn = WsConn::new(1024);
        let mut wire = Vec::new();
        wire.extend(make_client_frame(false, OPCODE_TEXT, b"hel", [1, 2, 3, 4]));
        wire.extend(make_client_frame(true, OPCODE_PING, b"hi", [5, 6, 7, 8]));
        wire.extend(make_client_frame(true, OPCODE_CONT, b"lo", [9, 10, 11, 12]));
        let mut close_payload = Vec::new();
        close_payload.extend_from_slice(&1000u16.to_be_bytes());
        close_payload.extend_from_slice(b"bye");
        wire.extend(make_client_frame(
            true,
            OPCODE_CLOSE,
            &close_payload,
            [4, 3, 2, 1],
        ));

        let mut out = Vec::new();
        let res = conn.feed(&wire, &mut out);
        assert_eq!(res.consumed, wire.len());
        assert!(res.close_after_write);
        assert_eq!(
            res.events,
            vec![
                WsEvent::Text("hello".to_owned()),
                WsEvent::Close {
                    code: 1000,
                    reason: "bye".to_owned(),
                },
            ]
        );
        // Pong + Close reply were written to `out`.
        assert_eq!(&out[0..4], &[0x80 | OPCODE_PONG, 2, b'h', b'i']);
        assert_eq!(&out[4..6], &[0x80 | OPCODE_CLOSE, 5]);
    }

    #[test]
    fn enforces_max_message_size_with_1009() {
        let mut conn = WsConn::new(8);
        let frame = make_client_frame(true, OPCODE_BINARY, &[0u8; 16], [1, 1, 1, 1]);
        let mut out = Vec::new();
        let res = conn.feed(&frame, &mut out);
        assert!(res.close_after_write);
        assert_eq!(
            res.events,
            vec![WsEvent::Close {
                code: 1009,
                reason: "message too large".to_owned(),
            }]
        );
        assert_eq!(out[0], 0x80 | OPCODE_CLOSE);
        assert_eq!(u16::from_be_bytes([out[2], out[3]]), 1009);
    }

    #[test]
    fn negotiates_and_roundtrips_permessage_deflate() {
        let cfg = WsDeflateConfig {
            enabled: true,
            server_no_context_takeover: true,
            client_no_context_takeover: true,
            server_max_window_bits: 12,
            client_max_window_bits: 12,
            threshold: 0,
            max_decompressed_size: 4096,
            level: 6,
            shared_compressor: false,
        };
        let negotiated =
            negotiate_permessage_deflate(Some("permessage-deflate; client_max_window_bits"), cfg)
                .expect("negotiated");
        assert!(negotiated
            .header_value
            .contains("server_no_context_takeover"));
        assert!(negotiated
            .header_value
            .contains("server_max_window_bits=12"));
        assert!(negotiated
            .header_value
            .contains("client_max_window_bits=12"));

        // RFC 7692 §7.1.2.2: cannot force client window bits < 15 if client omitted the param.
        assert!(negotiate_permessage_deflate(Some("permessage-deflate"), cfg).is_none());

        // Compress with raw deflate + strip 00 00 ff ff, send masked client frame with RSV1=1.
        let mut comp = Compress::new_with_window_bits(Compression::default(), false, 12);
        let msg = b"hello permessage-deflate ".repeat(32);
        let mut compressed = Vec::new();
        compress_deflate_payload(&mut comp, &msg, &mut compressed);
        let mut frame = make_client_frame(true, OPCODE_TEXT, &compressed, [7, 8, 9, 10]);
        frame[0] |= 0x40; // set RSV1

        let mut server_ws = WsConn::with_deflate(4096, Some(&negotiated));
        let mut out = Vec::new();
        let res = server_ws.feed(&frame, &mut out);
        assert_eq!(res.consumed, frame.len());
        assert_eq!(
            res.events,
            vec![WsEvent::Text(String::from_utf8(msg.clone()).unwrap())]
        );

        // Shared compressor mode forces server_no_context_takeover and resets state.
        let mut shared_cfg = cfg;
        shared_cfg.shared_compressor = true;
        shared_cfg.client_max_window_bits = 15;
        let shared_neg = negotiate_permessage_deflate(Some("permessage-deflate"), shared_cfg)
            .expect("shared negotiated");
        let mut shared_comp =
            new_shared_compressor(shared_neg.level, shared_neg.server_max_window_bits);
        let mut ws2 = WsConn::with_deflate(4096, Some(&shared_neg));
        let mut encoded = Vec::new();
        ws2.encode_server_message(OPCODE_BINARY, &msg, Some(&mut shared_comp), &mut encoded);
        assert_ne!(encoded[0] & 0x40, 0);
        assert!(encoded.len() < msg.len());
    }

    #[test]
    fn permessage_deflate_rejects_zip_bomb_and_invalid_rsv1() {
        let cfg = WsDeflateConfig {
            enabled: true,
            max_decompressed_size: 64,
            ..WsDeflateConfig::default()
        };
        let negotiated =
            negotiate_permessage_deflate(Some("permessage-deflate"), cfg).expect("negotiated");

        // Tiny compressed wire payload expands cleanly past 64 bytes -> 1009 before allocation.
        let mut comp = Compress::new_with_window_bits(Compression::best(), false, 15);
        let bomb_plain = vec![b'A'; 4096];
        let mut compressed = Vec::new();
        compress_deflate_payload(&mut comp, &bomb_plain, &mut compressed);
        assert!(compressed.len() < 64);

        let mut frame = make_client_frame(true, OPCODE_TEXT, &compressed, [1, 2, 3, 4]);
        frame[0] |= 0x40;
        let mut ws = WsConn::with_deflate(1024, Some(&negotiated));
        let mut out = Vec::new();
        let res = ws.feed(&frame, &mut out);
        assert!(res.close_after_write);
        assert_eq!(
            res.events,
            vec![WsEvent::Close {
                code: 1009,
                reason: "message too large".to_owned(),
            }]
        );

        // RSV1 on continuation frame is forbidden by RFC 7692 §6 -> 1002.
        let mut ws2 = WsConn::with_deflate(1024, Some(&negotiated));
        let mut wire = make_client_frame(false, OPCODE_TEXT, b"hi", [1, 2, 3, 4]);
        let mut cont = make_client_frame(true, OPCODE_CONT, b"!", [5, 6, 7, 8]);
        cont[0] |= 0x40;
        wire.extend(cont);
        let mut out2 = Vec::new();
        let res2 = ws2.feed(&wire, &mut out2);
        assert!(res2.close_after_write);
        assert_eq!(
            res2.events,
            vec![WsEvent::Close {
                code: 1002,
                reason: "protocol error".to_owned(),
            }]
        );
    }
}
