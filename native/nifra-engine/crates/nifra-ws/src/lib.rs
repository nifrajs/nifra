//! RFC 6455 WebSocket handshake, sans-I/O framing, fragmentation reassembly,
//! per-route payload cap enforcement, and peer close-reason propagation.

pub use fastwebsockets::{Frame, OpCode, Payload};

const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const OPCODE_CONT: u8 = 0x0;
pub const OPCODE_TEXT: u8 = 0x1;
pub const OPCODE_BINARY: u8 = 0x2;
pub const OPCODE_CLOSE: u8 = 0x8;
pub const OPCODE_PING: u8 = 0x9;
pub const OPCODE_PONG: u8 = 0xA;

#[derive(Debug, Clone, Copy)]
pub struct WsConfig {
    pub max_message_size: usize,
    pub backpressure_limit: usize,
}

impl Default for WsConfig {
    fn default() -> Self {
        Self {
            max_message_size: 16 * 1024 * 1024,
            backpressure_limit: 1024 * 1024,
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
    // Standard 16-byte nonce base64-encoded is 24 characters ending with `==`.
    if key.len() != 24 || !key.is_ascii() {
        return None;
    }
    Some(key)
}

/// Compute RFC 6455 §4.2.2 `Sec-WebSocket-Accept` from a client's `Sec-WebSocket-Key`.
pub fn compute_accept_key(key: &str) -> String {
    let mut input = Vec::with_capacity(key.len() + WS_GUID.len());
    input.extend_from_slice(key.as_bytes());
    input.extend_from_slice(WS_GUID.as_bytes());
    let digest = sha1(&input);
    base64_encode(&digest)
}

/// Write an HTTP/1.1 `101 Switching Protocols` WebSocket handshake response.
pub fn write_upgrade_response(accept_key: &str, out: &mut Vec<u8>) {
    out.extend_from_slice(
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ",
    );
    out.extend_from_slice(accept_key.as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
}

/// Write an unmasked server-to-client RFC 6455 frame.
pub fn write_server_frame(opcode: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(0x80 | (opcode & 0x0F));
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

/// Sans-I/O RFC 6455 server-side WebSocket connection state machine.
#[derive(Debug)]
pub struct WsConn {
    max_message_size: usize,
    frag_opcode: Option<u8>,
    frag_buf: Vec<u8>,
    close_sent: bool,
    closed: bool,
}

impl WsConn {
    pub fn new(max_message_size: usize) -> Self {
        Self {
            max_message_size,
            frag_opcode: None,
            frag_buf: Vec::new(),
            close_sent: false,
            closed: false,
        }
    }

    pub fn mark_close_sent(&mut self) {
        self.close_sent = true;
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

            // RFC 6455 §5.2: RSV bits must be 0 without extensions; client frames MUST be masked.
            if rsv != 0 || !masked {
                self.fail_protocol(1002, "protocol error", write_buf, &mut res, buf.len());
                return res;
            }

            let is_control = (opcode & 0x08) != 0;
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
                    (u16::from_be_bytes([rem[2], rem[3]]) as usize, 4usize)
                }
                127 => {
                    if rem.len() < 10 {
                        break;
                    }
                    let raw64 = u64::from_be_bytes([
                        rem[2], rem[3], rem[4], rem[5], rem[6], rem[7], rem[8], rem[9],
                    ]);
                    if (raw64 >> 63) != 0 {
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
                OPCODE_TEXT | OPCODE_BINARY => {
                    if self.frag_opcode.is_some() {
                        self.fail_protocol(1002, "protocol error", write_buf, &mut res, pos);
                        return res;
                    }
                    if fin {
                        if !self.emit_message(opcode, payload, write_buf, &mut res, pos) {
                            return res;
                        }
                    } else {
                        self.frag_opcode = Some(opcode);
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
                        self.frag_opcode = None;
                        let full = std::mem::take(&mut self.frag_buf);
                        if !self.emit_message(op, full, write_buf, &mut res, pos) {
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
        payload: Vec<u8>,
        write_buf: &mut Vec<u8>,
        res: &mut WsFeedResult,
        consumed: usize,
    ) -> bool {
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
}
