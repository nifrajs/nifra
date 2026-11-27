//! Zero-allocation HTTP/1.1 parser (including chunked transfer-encoding), request-smuggling
//! guards, native fast-path routes, prepared response templates, streaming/chunked framing,
//! and the batched shared-memory ABI layout for Nifra.

pub mod compress;
pub mod date;
pub mod h2;

use std::borrow::Cow;
use std::collections::HashMap;
use std::mem::MaybeUninit;

/// Header fields parsed without allocating.
pub const MAX_HEADERS: usize = 64;
/// Most header fields a request may carry; past [`MAX_HEADERS`] they are parsed on the heap.
const MAX_HEADERS_HEAVY: usize = 1024;
/// A head that arrives past this is not re-parsed until its blank line is in.
const REPARSE_LIMIT: usize = 4096;

/// Header bytes as latin-1, one char per byte, which is how Node, Bun and Deno read them.
pub(crate) fn latin1(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) if text.is_ascii() => text.to_owned(),
        _ => bytes.iter().map(|&b| char::from(b)).collect(),
    }
}

fn trim_ows(mut bytes: &[u8]) -> &[u8] {
    while let [b' ' | b'\t', rest @ ..] = bytes {
        bytes = rest;
    }
    while let [rest @ .., b' ' | b'\t'] = bytes {
        bytes = rest;
    }
    bytes
}

/// Whether every line feed in a request head follows a carriage return. A bare LF ends a line for
/// some parsers and not others, which is a request-smuggling gap behind a proxy (RFC 9112 §2.2).
fn lines_end_in_crlf(head: &[u8]) -> bool {
    memchr::memchr_iter(b'\n', head).all(|at| at > 0 && head[at - 1] == b'\r')
}

/// An origin-form or absolute-form target, or `*` for `OPTIONS` (RFC 9112 §3.2).
fn is_routable_target(method: &str, target: &str) -> bool {
    if target.starts_with('/') {
        return true;
    }
    if target == "*" {
        return method == "OPTIONS";
    }
    target.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    })
}

/// Parse a request head, on the stack up to [`MAX_HEADERS`] fields and on the heap past that.
fn parse_head<'h, 'b>(
    buf: &'b [u8],
    inline: &'h mut [MaybeUninit<httparse::Header<'b>>; MAX_HEADERS],
    heavy: &'h mut Vec<MaybeUninit<httparse::Header<'b>>>,
) -> (httparse::Request<'h, 'b>, httparse::Result<usize>) {
    let mut req = httparse::Request::new(&mut []);
    let mut parsed = req.parse_with_uninit_headers(buf, inline);
    if parsed == Err(httparse::Error::TooManyHeaders) {
        heavy.resize_with(MAX_HEADERS_HEAVY, MaybeUninit::uninit);
        req = httparse::Request::new(&mut []);
        parsed = req.parse_with_uninit_headers(buf, heavy);
    }
    (req, parsed)
}

/// A long head with no blank line yet is not worth reparsing on every read.
fn head_surely_partial(buf: &[u8]) -> bool {
    buf.len() > REPARSE_LIMIT && !buf.windows(4).any(|w| w == b"\r\n\r\n")
}

/// Whether a request whose body has not all arrived asked for `100 Continue` before sending it;
/// `None` while its head is still arriving.
pub fn awaits_continue(buf: &[u8]) -> Option<bool> {
    if head_surely_partial(buf) {
        return None;
    }
    let mut inline = [const { MaybeUninit::uninit() }; MAX_HEADERS];
    let mut heavy = Vec::new();
    let (req, parsed) = parse_head(buf, &mut inline, &mut heavy);
    let Ok(httparse::Status::Complete(_)) = parsed else {
        return None;
    };
    Some(
        req.version == Some(1)
            && req.headers.iter().any(|h| {
                h.name.eq_ignore_ascii_case("expect")
                    && trim_ows(h.value).eq_ignore_ascii_case(b"100-continue")
            }),
    )
}

/// Bitflags and slot constants shared verbatim between Rust and JS (`packages/node-engine`).
pub mod abi {
    /// 8 x u32 (32 bytes) per inbound request in `inMeta`.
    pub const IN_SLOT_U32S: usize = 10;
    /// 4 x u32 (16 bytes) per outbound response in `outMeta`.
    pub const OUT_SLOT_U32S: usize = 5;

    pub const METHOD_MASK: u32 = 0x0F;
    pub const FLAG_HAS_BODY: u32 = 1 << 4;
    pub const FLAG_IS_ASCII_BODY: u32 = 1 << 5;
    pub const FLAG_IS_WS_UPGRADE: u32 = 1 << 6;
    pub const FLAG_IS_H2: u32 = 1 << 7;
    pub const FLAG_HOST_VALID: u32 = 1 << 8;
    pub const FLAG_OVER_MAX_BODY: u32 = 1 << 9;
    pub const FLAG_LARGE_BODY: u32 = 1 << 10;
    pub const FLAG_CT_JSON: u32 = 1 << 11;
    pub const FLAG_CHUNKED: u32 = 1 << 12;
    /// The request carried a `Content-Type`; its first value is in the batch at slot words 8 and 9
    /// (offset, length), so the adapter reads it without a call into the engine.
    pub const FLAG_HAS_CT: u32 = 1 << 13;
    /// Request body streams incrementally via `onReqBody(reqId, chunk, end)` after head dispatch.
    pub const FLAG_STREAM_BODY: u32 = 1 << 14;

    /// Sentinel offset indicating the body exceeds the inline slab and must be read via `getBody(id)`.
    pub const LARGE_BODY_SENTINEL: u32 = u32::MAX;
    pub const INLINE_BODY_MAX: usize = 64 * 1024;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    Malformed,
    DuplicateHost,
    MissingHost,
    ConflictingContentLength,
    ContentLengthWithTransferEncoding,
    DuplicateTransferEncoding,
    PayloadTooLarge,
    HeadersTooLarge,
    UriTooLarge,
}

#[derive(Debug, Clone, Copy)]
pub struct ParseLimits {
    pub max_body_size: usize,
    pub oversize_window: usize,
    pub max_header_bytes: usize,
    /// Maximum number of headers allowed on one request (`0` = default 64, capped conservatively).
    pub max_headers: usize,
    /// Maximum length in bytes of the request target (`path` + `?query`); `0` = bounded only by `max_header_bytes`.
    pub max_uri_size: usize,
    /// Emit `ParseStatus::StreamHead` for non-empty incomplete or oversized bodies so JS can stream uploads.
    pub stream_request_bodies: bool,
}

impl Default for ParseLimits {
    fn default() -> Self {
        Self {
            max_body_size: 1_048_576,
            oversize_window: 1_048_576,
            max_header_bytes: 16 * 1024,
            max_headers: 0,
            max_uri_size: 0,
            stream_request_bodies: false,
        }
    }
}

#[derive(Debug)]
pub struct ParsedRequest<'a> {
    pub method_idx: u8,
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub host: Option<&'a str>,
    pub host_valid: bool,
    pub is_json_ct: bool,
    /// First `Content-Type` value, trimmed, as sent.
    pub content_type: Option<&'a [u8]>,
    pub http10: bool,
    pub is_chunked: bool,
    pub is_ws_upgrade: bool,
    pub keep_alive: bool,
    pub over_max_body: bool,
    pub head_len: usize,
    pub body: Cow<'a, [u8]>,
    pub total_bytes: usize,
}

#[derive(Debug)]
pub struct ParsedStreamHead<'a> {
    pub method_idx: u8,
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub host: Option<&'a str>,
    pub host_valid: bool,
    pub is_json_ct: bool,
    pub content_type: Option<&'a [u8]>,
    pub http10: bool,
    pub is_chunked: bool,
    pub is_ws_upgrade: bool,
    pub keep_alive: bool,
    pub content_length: Option<u64>,
    pub head_len: usize,
}

#[derive(Debug)]
pub enum ParseStatus<'a> {
    Incomplete,
    Complete(ParsedRequest<'a>),
    StreamHead(ParsedStreamHead<'a>),
}

#[inline]
pub fn method_to_idx(method: &str) -> u8 {
    match method {
        "GET" => 0,
        "POST" => 1,
        "PUT" => 2,
        "DELETE" => 3,
        "PATCH" => 4,
        "HEAD" => 5,
        "OPTIONS" => 6,
        _ => 7,
    }
}

/// Fast RFC 9110 Host syntax check (rejects spaces, `@`, `/`, control chars, invalid port).
#[inline]
pub fn is_valid_host(host: &str) -> bool {
    let bytes = host.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if bytes[0] == b'[' {
        let Some(end) = memchr::memchr(b']', &bytes[1..]) else {
            return false;
        };
        let address = &host[1..1 + end];
        if address.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        let suffix = &bytes[2 + end..];
        if suffix.is_empty() {
            return true;
        }
        return suffix[0] == b':' && is_valid_port_bytes(&suffix[1..]);
    }

    let mut idx = 0usize;
    while idx < bytes.len() {
        let b = bytes[idx];
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
            idx += 1;
            continue;
        }
        if b == b':' {
            return idx > 0 && is_valid_port_bytes(&bytes[idx + 1..]);
        }
        return false;
    }
    true
}

#[inline]
fn is_valid_port_bytes(port: &[u8]) -> bool {
    if port.is_empty() || port.len() > 5 {
        return false;
    }
    let mut val = 0u32;
    for &b in port {
        if !b.is_ascii_digit() {
            return false;
        }
        val = val * 10 + u32::from(b - b'0');
    }
    val <= u32::from(u16::MAX)
}

/// Validate an RFC 9110 HTTP header name (tchar token).
#[inline]
pub fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// Validate an RFC 9110 HTTP header value (no CR, LF, NUL, or control chars other than HTAB).
#[inline]
pub fn is_valid_header_value(val: &str) -> bool {
    val.bytes()
        .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b) || b >= 0x80)
}

enum ChunkedStatus {
    Incomplete,
    Complete { body: Vec<u8>, consumed: usize },
}

/// Longest chunk-size line (hex size plus extensions) a request may carry.
const MAX_CHUNK_LINE: usize = 4096;
/// Longest trailer section a chunked request may carry.
const MAX_CHUNK_TRAILERS: usize = 16 * 1024;

/// Where a chunked body decode stopped, so the next read continues instead of starting over.
///
/// The caller keeps one per connection while a request is `Incomplete` and passes it back with the
/// same buffer start. Without it every arriving segment re-decodes the whole body, which is quadratic
/// for a client that sends many small chunks.
#[derive(Debug, Default)]
pub struct ChunkResume {
    active: bool,
    /// Offset, from the end of the head, of the next chunk-size line.
    pos: usize,
    body: Vec<u8>,
    /// Wire bytes spent on size lines, extensions, CRLFs and trailers rather than payload.
    framing: usize,
    examined: u64,
    /// Once the zero-size chunk is read: where the trailers stand, so a short read resumes inside
    /// them instead of at the size line.
    trailer: Option<TrailerScan>,
}

#[derive(Debug, Clone, Copy)]
struct TrailerScan {
    /// Where the trailer section begins.
    start: usize,
    /// Where the line being read begins.
    line_start: usize,
    /// How many bytes of that line were already searched for its end.
    searched: usize,
    /// Length of the zero-size chunk line.
    size_line: usize,
}

impl ChunkResume {
    /// Whether a chunked body is partway through a decode and must be kept for the next read.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Wire bytes the decoder has looked at so far; a work gauge for tests.
    pub fn examined(&self) -> u64 {
        self.examined
    }
}

/// Strict RFC 9112 §7.1 chunk-size line: `1*HEXDIG [ BWS ";" ext ]`, with no sign or stray whitespace.
fn parse_chunk_size(line: &[u8]) -> Result<usize, ParseError> {
    if line.iter().any(|&b| b == b'\r' || b == 0) {
        return Err(ParseError::Malformed);
    }
    let size = match memchr::memchr(b';', line) {
        Some(semi) => {
            let mut end = semi;
            while end > 0 && matches!(line[end - 1], b' ' | b'\t') {
                end -= 1;
            }
            &line[..end]
        }
        None => line,
    };
    if size.is_empty() || size.len() > 16 || !size.iter().all(u8::is_ascii_hexdigit) {
        return Err(ParseError::Malformed);
    }
    let text = std::str::from_utf8(size).map_err(|_| ParseError::Malformed)?;
    usize::from_str_radix(text, 16).map_err(|_| ParseError::Malformed)
}

/// Incrementally decode an RFC 9112 §7.1 `Transfer-Encoding: chunked` body up to `hard_cap`,
/// resuming from `resume` and refusing more than `framing_cap` bytes of non-payload framing.
fn decode_chunked(
    buf: &[u8],
    hard_cap: usize,
    framing_cap: usize,
    resume: &mut ChunkResume,
) -> Result<ChunkedStatus, ParseError> {
    if let Some(scan) = resume.trailer {
        return scan_trailers(buf, scan, framing_cap, resume);
    }
    let mut pos = resume.pos;

    loop {
        let rest = &buf[pos.min(buf.len())..];
        let Some(rel_lf) = memchr::memchr(b'\n', rest) else {
            resume.examined += rest.len() as u64;
            if rest.len() > MAX_CHUNK_LINE {
                return Err(ParseError::Malformed);
            }
            resume.pos = pos;
            return Ok(ChunkedStatus::Incomplete);
        };
        resume.examined += rel_lf as u64 + 1;
        if rel_lf == 0 || rel_lf > MAX_CHUNK_LINE || rest[rel_lf - 1] != b'\r' {
            return Err(ParseError::Malformed);
        }
        let chunk_len = parse_chunk_size(&rest[..rel_lf - 1])?;
        let line_total = rel_lf + 1;

        if chunk_len == 0 {
            // Trailer lines end at an empty line; the whole section is bounded.
            let start = pos + line_total;
            let scan = TrailerScan {
                start,
                line_start: start,
                searched: 0,
                size_line: line_total,
            };
            return scan_trailers(buf, scan, framing_cap, resume);
        }

        let new_len = resume
            .body
            .len()
            .checked_add(chunk_len)
            .ok_or(ParseError::PayloadTooLarge)?;
        if new_len > hard_cap {
            return Err(ParseError::PayloadTooLarge);
        }

        let data_start = pos + line_total;
        let data_end = data_start
            .checked_add(chunk_len)
            .ok_or(ParseError::PayloadTooLarge)?;
        let chunk_end = data_end.checked_add(2).ok_or(ParseError::PayloadTooLarge)?;
        if buf.len() < chunk_end {
            resume.pos = pos;
            return Ok(ChunkedStatus::Incomplete);
        }
        if &buf[data_end..chunk_end] != b"\r\n" {
            return Err(ParseError::Malformed);
        }
        resume.framing = resume.framing.saturating_add(line_total + 2);
        if resume.framing > framing_cap {
            return Err(ParseError::PayloadTooLarge);
        }
        resume.examined += chunk_len as u64 + 2;
        resume.body.extend_from_slice(&buf[data_start..data_end]);
        pos = chunk_end;
        resume.pos = pos;
    }
}

/// The trailer section after a zero-size chunk, bounded as a whole and resumed where a short read stopped.
fn scan_trailers(
    buf: &[u8],
    mut scan: TrailerScan,
    framing_cap: usize,
    resume: &mut ChunkResume,
) -> Result<ChunkedStatus, ParseError> {
    loop {
        let tail = &buf[scan.line_start.min(buf.len())..];
        if tail.len() >= 2 && &tail[..2] == b"\r\n" {
            resume.examined += 2;
            let consumed = scan.line_start + 2;
            let framing = resume
                .framing
                .saturating_add(scan.size_line)
                .saturating_add(consumed - scan.start);
            if framing > framing_cap {
                return Err(ParseError::PayloadTooLarge);
            }
            resume.trailer = None;
            return Ok(ChunkedStatus::Complete {
                body: std::mem::take(&mut resume.body),
                consumed,
            });
        }
        let from = scan.searched.min(tail.len());
        let Some(rel) = memchr::memchr(b'\n', &tail[from..]) else {
            resume.examined += (tail.len() - from) as u64;
            if scan.line_start - scan.start + tail.len() > MAX_CHUNK_TRAILERS {
                return Err(ParseError::Malformed);
            }
            scan.searched = tail.len();
            resume.trailer = Some(scan);
            return Ok(ChunkedStatus::Incomplete);
        };
        let t_lf = from + rel;
        resume.examined += rel as u64 + 1;
        if t_lf == 0 || tail[t_lf - 1] != b'\r' {
            return Err(ParseError::Malformed);
        }
        scan.line_start += t_lf + 1;
        scan.searched = 0;
        if scan.line_start - scan.start > MAX_CHUNK_TRAILERS {
            return Err(ParseError::Malformed);
        }
    }
}

/// Parse one complete HTTP/1.1 request (Content-Length or chunked) with strict smuggling guards.
pub fn parse_http1<'a>(buf: &'a [u8], limits: ParseLimits) -> Result<ParseStatus<'a>, ParseError> {
    parse_http1_resume(buf, limits, &mut ChunkResume::default())
}

#[inline]
fn parse_trimmed_u64(raw: &str) -> Result<u64, ParseError> {
    let mut bytes = raw.as_bytes();
    while let Some((&b, rest)) = bytes.split_first() {
        if b.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    while let Some((&b, rest)) = bytes.split_last() {
        if b.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    if bytes.is_empty() {
        return Err(ParseError::Malformed);
    }
    let mut acc = 0u64;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return Err(ParseError::Malformed);
        }
        acc = acc
            .checked_mul(10)
            .and_then(|v| v.checked_add(u64::from(b - b'0')))
            .ok_or(ParseError::Malformed)?;
    }
    Ok(acc)
}

#[inline]
fn partial_request_target_len(buf: &[u8]) -> Option<usize> {
    let first_line = match memchr::memchr(b'\n', buf) {
        Some(pos) => &buf[..pos],
        None => buf,
    };
    let line = first_line.strip_suffix(b"\r").unwrap_or(first_line);
    let sp1 = memchr::memchr(b' ', line)?;
    let after_method = &line[sp1 + 1..];
    match memchr::memchr(b' ', after_method) {
        Some(sp2) => Some(sp2),
        None => Some(after_method.len()),
    }
}

/// [`parse_http1`] that continues a partly decoded chunked body from `resume` instead of restarting.
///
/// Pass the same `resume` with a buffer that starts at the same request on every call until it returns
/// `Complete` or an error; discard it then. `resume.is_active()` after `Incomplete` means keep it.
pub fn parse_http1_resume<'a>(
    buf: &'a [u8],
    limits: ParseLimits,
    resume: &mut ChunkResume,
) -> Result<ParseStatus<'a>, ParseError> {
    if head_surely_partial(buf) {
        if limits.max_uri_size > 0
            && partial_request_target_len(buf).is_some_and(|len| len > limits.max_uri_size)
        {
            return Err(ParseError::UriTooLarge);
        }
        if buf.len() > limits.max_header_bytes {
            return Err(ParseError::HeadersTooLarge);
        }
        return Ok(ParseStatus::Incomplete);
    }
    let mut inline = [const { MaybeUninit::uninit() }; MAX_HEADERS];
    let mut heavy = Vec::new();
    let (req, parsed) = parse_head(buf, &mut inline, &mut heavy);
    let head_len = match parsed {
        Ok(httparse::Status::Complete(n)) => {
            let target_len = req.path.map_or(0, str::len);
            if limits.max_uri_size > 0 && target_len > limits.max_uri_size {
                return Err(ParseError::UriTooLarge);
            }
            if n > limits.max_header_bytes
                || (limits.max_headers > 0 && req.headers.len() > limits.max_headers)
            {
                return Err(ParseError::HeadersTooLarge);
            }
            if !lines_end_in_crlf(&buf[..n]) {
                return Err(ParseError::Malformed);
            }
            n
        }
        Ok(httparse::Status::Partial) => {
            if limits.max_uri_size > 0
                && partial_request_target_len(buf).is_some_and(|len| len > limits.max_uri_size)
            {
                return Err(ParseError::UriTooLarge);
            }
            if buf.len() > limits.max_header_bytes {
                return Err(ParseError::HeadersTooLarge);
            }
            return Ok(ParseStatus::Incomplete);
        }
        Err(httparse::Error::TooManyHeaders) => return Err(ParseError::HeadersTooLarge),
        Err(_) => return Err(ParseError::Malformed),
    };

    let method = req.method.ok_or(ParseError::Malformed)?;
    let raw_target = req.path.ok_or(ParseError::Malformed)?;
    if !is_routable_target(method, raw_target) {
        return Err(ParseError::Malformed);
    }
    let (path, query) = match memchr::memchr(b'?', raw_target.as_bytes()) {
        Some(pos) => (&raw_target[..pos], &raw_target[pos + 1..]),
        None => (raw_target, ""),
    };

    let mut host: Option<&'a str> = None;
    let mut content_length: Option<u64> = None;
    let mut is_json_ct = None;
    let mut content_type: Option<&'a [u8]> = None;
    let mut is_chunked = false;
    let mut has_te = false;
    let mut is_ws_upgrade = false;
    let default_keep_alive = req.version.unwrap_or(1) == 1;
    let mut close_seen = false;
    let mut keep_alive_seen = false;

    for h in req.headers.iter() {
        let name = h.name;
        // `httparse` already rejects all control bytes except HTAB via `HEADER_VALUE_MAP`.
        // A field that frames or routes the request must be text; any other may be any bytes.
        let text = std::str::from_utf8(h.value);
        let strict = || text.map_err(|_| ParseError::Malformed);
        let val = text.unwrap_or("");
        match name.len() {
            4 if name.eq_ignore_ascii_case("host") => {
                if host.is_some() {
                    return Err(ParseError::DuplicateHost);
                }
                host = Some(strict()?.trim_matches([' ', '\t']));
            }
            7 if name.eq_ignore_ascii_case("upgrade") => {
                if val.trim().eq_ignore_ascii_case("websocket") {
                    is_ws_upgrade = true;
                }
            }
            10 if name.eq_ignore_ascii_case("connection") => {
                // A token list across every `Connection` field: `close` wins over `keep-alive`.
                for token in val.split(',') {
                    let token = token.trim();
                    close_seen |= token.eq_ignore_ascii_case("close");
                    keep_alive_seen |= token.eq_ignore_ascii_case("keep-alive");
                }
            }
            12 if is_json_ct.is_none() && name.eq_ignore_ascii_case("content-type") => {
                let end = memchr::memchr(b';', h.value).unwrap_or(h.value.len());
                let essence = trim_ows(&h.value[..end]);
                is_json_ct = Some(essence.eq_ignore_ascii_case(b"application/json"));
                content_type = Some(trim_ows(h.value));
            }
            14 if name.eq_ignore_ascii_case("content-length") => {
                let parsed = parse_trimmed_u64(strict()?)?;
                if let Some(prev) = content_length {
                    if prev != parsed {
                        return Err(ParseError::ConflictingContentLength);
                    }
                }
                content_length = Some(parsed);
            }
            17 if name.eq_ignore_ascii_case("transfer-encoding") => {
                if has_te {
                    return Err(ParseError::DuplicateTransferEncoding);
                }
                has_te = true;
                if strict()?.trim().eq_ignore_ascii_case("chunked") {
                    is_chunked = true;
                } else {
                    return Err(ParseError::Malformed);
                }
            }
            _ => {}
        }
    }

    let http10 = req.version == Some(0);
    if !http10 && host.is_none() {
        return Err(ParseError::MissingHost);
    }
    if has_te && content_length.is_some() {
        return Err(ParseError::ContentLengthWithTransferEncoding);
    }

    let keep_alive = !close_seen && (keep_alive_seen || default_keep_alive);
    let host_valid = host.is_some_and(is_valid_host);

    if limits.stream_request_bodies && !is_ws_upgrade && !resume.is_active() {
        let should_stream = if is_chunked {
            true
        } else {
            let cl = content_length.unwrap_or(0);
            cl > limits.max_body_size as u64
                || (cl > 0 && (buf.len() as u64) < (head_len as u64).saturating_add(cl))
        };
        if should_stream {
            return Ok(ParseStatus::StreamHead(ParsedStreamHead {
                method_idx: method_to_idx(method),
                method,
                path,
                query,
                host,
                host_valid,
                is_json_ct: is_json_ct.unwrap_or(false),
                content_type,
                http10,
                is_chunked,
                is_ws_upgrade,
                keep_alive,
                content_length,
                head_len,
            }));
        }
    }

    let hard_cap = limits.max_body_size.saturating_add(limits.oversize_window);
    let (body, total_bytes) = if is_chunked {
        resume.active = true;
        let framing_cap = limits.max_header_bytes.saturating_add(hard_cap / 8);
        match decode_chunked(&buf[head_len..], hard_cap, framing_cap, resume)? {
            ChunkedStatus::Incomplete => return Ok(ParseStatus::Incomplete),
            ChunkedStatus::Complete { body, consumed } => {
                let total = head_len
                    .checked_add(consumed)
                    .ok_or(ParseError::PayloadTooLarge)?;
                (Cow::Owned(body), total)
            }
        }
    } else {
        let body_len_u64 = content_length.unwrap_or(0);
        if body_len_u64 > hard_cap as u64 {
            return Err(ParseError::PayloadTooLarge);
        }
        let body_len = body_len_u64 as usize;
        let total = head_len
            .checked_add(body_len)
            .ok_or(ParseError::PayloadTooLarge)?;
        if buf.len() < total {
            return Ok(ParseStatus::Incomplete);
        }
        (Cow::Borrowed(&buf[head_len..total]), total)
    };

    let over_max_body = body.len() > limits.max_body_size;

    Ok(ParseStatus::Complete(ParsedRequest {
        method_idx: method_to_idx(method),
        method,
        path,
        query,
        host,
        host_valid,
        is_json_ct: is_json_ct.unwrap_or(false),
        content_type,
        http10,
        is_chunked,
        is_ws_upgrade,
        keep_alive,
        over_max_body,
        head_len,
        body,
        total_bytes,
    }))
}

/// Decoded step emitted by [`H1BodyDecoder::feed`].
#[derive(Debug)]
pub struct H1BodyStep<'a> {
    pub consumed: usize,
    pub chunk: &'a [u8],
    pub done: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkStreamPhase {
    SizeLine,
    Data(u64),
    DataCrlf,
    Trailers(usize),
    Done,
}

/// Incremental sans-I/O decoder for streaming HTTP/1.1 request bodies (fixed `Content-Length` up to
/// 64-bit sizes, or `Transfer-Encoding: chunked`).
#[derive(Debug)]
pub struct H1BodyDecoder(H1BodyDecoderInner);

#[derive(Debug)]
enum H1BodyDecoderInner {
    Fixed { remaining: u64 },
    Chunked { phase: ChunkStreamPhase },
}

impl H1BodyDecoder {
    pub fn fixed(content_length: u64) -> Self {
        Self(H1BodyDecoderInner::Fixed {
            remaining: content_length,
        })
    }

    pub fn chunked() -> Self {
        Self(H1BodyDecoderInner::Chunked {
            phase: ChunkStreamPhase::SizeLine,
        })
    }

    pub fn is_done(&self) -> bool {
        match &self.0 {
            H1BodyDecoderInner::Fixed { remaining } => *remaining == 0,
            H1BodyDecoderInner::Chunked { phase } => *phase == ChunkStreamPhase::Done,
        }
    }

    /// Decode at most one contiguous payload slice from `buf`. Callers loop while
    /// `step.consumed > 0 && !step.done` to drain a read buffer completely.
    pub fn feed<'a>(&mut self, buf: &'a [u8]) -> Result<H1BodyStep<'a>, ParseError> {
        match &mut self.0 {
            H1BodyDecoderInner::Fixed { remaining } => {
                if *remaining == 0 {
                    return Ok(H1BodyStep {
                        consumed: 0,
                        chunk: &[],
                        done: true,
                    });
                }
                let take = (*remaining).min(buf.len() as u64) as usize;
                *remaining -= take as u64;
                Ok(H1BodyStep {
                    consumed: take,
                    chunk: &buf[..take],
                    done: *remaining == 0,
                })
            }
            H1BodyDecoderInner::Chunked { phase } => {
                let mut pos = 0usize;
                loop {
                    match *phase {
                        ChunkStreamPhase::Done => {
                            return Ok(H1BodyStep {
                                consumed: pos,
                                chunk: &[],
                                done: true,
                            });
                        }
                        ChunkStreamPhase::SizeLine => {
                            let rest = &buf[pos..];
                            let Some(rel_lf) = memchr::memchr(b'\n', rest) else {
                                if rest.len() > MAX_CHUNK_LINE {
                                    return Err(ParseError::Malformed);
                                }
                                return Ok(H1BodyStep {
                                    consumed: pos,
                                    chunk: &[],
                                    done: false,
                                });
                            };
                            if rel_lf == 0 || rel_lf > MAX_CHUNK_LINE || rest[rel_lf - 1] != b'\r' {
                                return Err(ParseError::Malformed);
                            }
                            let len = parse_chunk_size_u64(&rest[..rel_lf - 1])?;
                            pos += rel_lf + 1;
                            *phase = if len == 0 {
                                ChunkStreamPhase::Trailers(0)
                            } else {
                                ChunkStreamPhase::Data(len)
                            };
                        }
                        ChunkStreamPhase::Data(rem) => {
                            if pos >= buf.len() {
                                return Ok(H1BodyStep {
                                    consumed: pos,
                                    chunk: &[],
                                    done: false,
                                });
                            }
                            let take = rem.min((buf.len() - pos) as u64) as usize;
                            let start = pos;
                            pos += take;
                            let left = rem - take as u64;
                            *phase = if left == 0 {
                                ChunkStreamPhase::DataCrlf
                            } else {
                                ChunkStreamPhase::Data(left)
                            };
                            return Ok(H1BodyStep {
                                consumed: pos,
                                chunk: &buf[start..pos],
                                done: false,
                            });
                        }
                        ChunkStreamPhase::DataCrlf => {
                            let rest = &buf[pos..];
                            if rest.len() < 2 {
                                return Ok(H1BodyStep {
                                    consumed: pos,
                                    chunk: &[],
                                    done: false,
                                });
                            }
                            if &rest[..2] != b"\r\n" {
                                return Err(ParseError::Malformed);
                            }
                            pos += 2;
                            *phase = ChunkStreamPhase::SizeLine;
                        }
                        ChunkStreamPhase::Trailers(ref mut used) => {
                            let rest = &buf[pos..];
                            if rest.len() >= 2 && &rest[..2] == b"\r\n" {
                                pos += 2;
                                *phase = ChunkStreamPhase::Done;
                                return Ok(H1BodyStep {
                                    consumed: pos,
                                    chunk: &[],
                                    done: true,
                                });
                            }
                            let Some(rel_lf) = memchr::memchr(b'\n', rest) else {
                                if used.saturating_add(rest.len()) > MAX_CHUNK_TRAILERS {
                                    return Err(ParseError::Malformed);
                                }
                                return Ok(H1BodyStep {
                                    consumed: pos,
                                    chunk: &[],
                                    done: false,
                                });
                            };
                            if rel_lf == 0 || rest[rel_lf - 1] != b'\r' {
                                return Err(ParseError::Malformed);
                            }
                            *used = used.saturating_add(rel_lf + 1);
                            if *used > MAX_CHUNK_TRAILERS {
                                return Err(ParseError::Malformed);
                            }
                            pos += rel_lf + 1;
                        }
                    }
                }
            }
        }
    }
}

fn parse_chunk_size_u64(line: &[u8]) -> Result<u64, ParseError> {
    if line.iter().any(|&b| b == b'\r' || b == 0) {
        return Err(ParseError::Malformed);
    }
    let size = match memchr::memchr(b';', line) {
        Some(semi) => {
            let mut end = semi;
            while end > 0 && matches!(line[end - 1], b' ' | b'\t') {
                end -= 1;
            }
            &line[..end]
        }
        None => line,
    };
    if size.is_empty() || size.len() > 16 || !size.iter().all(u8::is_ascii_hexdigit) {
        return Err(ParseError::Malformed);
    }
    let text = std::str::from_utf8(size).map_err(|_| ParseError::Malformed)?;
    u64::from_str_radix(text, 16).map_err(|_| ParseError::Malformed)
}

/// Lazily collect all headers from a saved raw HTTP/1.1 head as `[lowercase_name, value, ...]`.
pub fn collect_headers_in_head(raw_head: &[u8]) -> Vec<String> {
    let mut inline = [const { MaybeUninit::uninit() }; MAX_HEADERS];
    let mut heavy = Vec::new();
    let (req, parsed) = parse_head(raw_head, &mut inline, &mut heavy);
    let Ok(httparse::Status::Complete(_)) = parsed else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(req.headers.len() * 2);
    for h in req.headers.iter() {
        out.push(h.name.to_ascii_lowercase());
        out.push(latin1(trim_ows(h.value)));
    }
    out
}

/// Pre-framed native responses for `staticResponse()` and `echoParam()` routes (bypass JS completely).
#[derive(Default)]
pub struct FastRoutes {
    static_get: HashMap<String, StaticRoute>,
    static_post: HashMap<String, StaticRoute>,
    param_get: Vec<ParamRoute>,
}

/// A fixed reply: the invariant head and the body, joined with the current `Date` on every hit.
struct StaticRoute {
    head: Vec<u8>,
    body: Vec<u8>,
}

impl StaticRoute {
    fn new(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Self {
        let mut head = Vec::with_capacity(128);
        write_head_prefix(&mut head, status, headers);
        Self {
            head,
            body: body.to_vec(),
        }
    }
}

struct ParamRoute {
    prefix: String,
    suffix: String,
    head_prefix: Vec<u8>,
}

impl FastRoutes {
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.static_get.is_empty() && self.static_post.is_empty() && self.param_get.is_empty()
    }
    pub fn add_static_get(
        &mut self,
        path: String,
        status: u16,
        headers: &[(&str, &str)],
        body: &[u8],
    ) {
        self.static_get
            .insert(path, StaticRoute::new(status, headers, body));
    }

    pub fn add_static_post(
        &mut self,
        path: String,
        status: u16,
        headers: &[(&str, &str)],
        body: &[u8],
    ) {
        self.static_post
            .insert(path, StaticRoute::new(status, headers, body));
    }

    pub fn add_param_get(
        &mut self,
        prefix: String,
        suffix: String,
        status: u16,
        headers: &[(&str, &str)],
    ) {
        let mut head_prefix = Vec::with_capacity(128);
        write_head_prefix(&mut head_prefix, status, headers);
        self.param_get.push(ParamRoute {
            prefix,
            suffix,
            head_prefix,
        });
    }

    #[inline]
    pub fn try_match_get(&self, path: &str, out: &mut Vec<u8>) -> bool {
        if let Some(route) = self.static_get.get(path) {
            out.extend_from_slice(&route.head);
            append_content_length_and_body(out, &route.body);
            return true;
        }
        for route in &self.param_get {
            if let Some(rest) = path.strip_prefix(&route.prefix) {
                if let Some(seg) = rest.strip_suffix(&route.suffix) {
                    if !seg.is_empty() && !seg.as_bytes().contains(&b'/') {
                        out.extend_from_slice(&route.head_prefix);
                        append_content_length_and_body(out, seg.as_bytes());
                        return true;
                    }
                }
            }
        }
        false
    }

    #[inline]
    pub fn try_match_post(&self, path: &str, out: &mut Vec<u8>) -> bool {
        if let Some(route) = self.static_post.get(path) {
            out.extend_from_slice(&route.head);
            append_content_length_and_body(out, &route.body);
            return true;
        }
        false
    }
}

#[derive(Default)]
struct TemplateEntry {
    prefix: Vec<u8>,
    cached_sec: u64,
    cached_head: Vec<u8>,
}

/// Prepared response templates (`prepareResponse` / `respondPrepared`).
#[derive(Default)]
pub struct PreparedTemplates {
    entries: Vec<TemplateEntry>,
}

impl PreparedTemplates {
    pub fn register(&mut self, status: u16, headers: &[(&str, &str)]) -> u32 {
        let mut prefix = Vec::with_capacity(128);
        write_head_prefix(&mut prefix, status, headers);
        let id = self.entries.len() as u32;
        self.entries.push(TemplateEntry {
            prefix,
            cached_sec: u64::MAX,
            cached_head: Vec::new(),
        });
        id
    }

    #[inline]
    pub fn write_prepared(&self, template_id: u32, body: &[u8], out: &mut Vec<u8>) -> bool {
        let Some(entry) = self.entries.get(template_id as usize) else {
            return false;
        };
        out.extend_from_slice(&entry.prefix);
        append_content_length_and_body(out, body);
        true
    }

    /// Write a prepared response reusing the pre-baked `prefix + date + content-length: ` header block
    /// whenever `sec` matches the template's cached second.
    #[inline]
    pub fn write_prepared_at(
        &mut self,
        template_id: u32,
        sec: u64,
        date_text: &[u8; date::IMF_LEN],
        body: &[u8],
        out: &mut Vec<u8>,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(template_id as usize) else {
            return false;
        };
        if entry.cached_sec != sec {
            entry.cached_head.clear();
            entry
                .cached_head
                .reserve(entry.prefix.len() + 6 + date::IMF_LEN + 2 + 16);
            entry.cached_head.extend_from_slice(&entry.prefix);
            entry.cached_head.extend_from_slice(b"date: ");
            entry.cached_head.extend_from_slice(date_text);
            entry.cached_head.extend_from_slice(b"\r\ncontent-length: ");
            entry.cached_sec = sec;
        }
        let mut num = itoa::Buffer::new();
        let len_bytes = num.format(body.len()).as_bytes();
        let h_len = entry.cached_head.len();
        let l_len = len_bytes.len();
        let b_len = body.len();
        let old_len = out.len();
        out.reserve(h_len + l_len + 4 + b_len);
        // SAFETY: `reserve` guaranteed capacity for all written bytes, and the slices are disjoint from `out`.
        unsafe {
            let dst = out.as_mut_ptr().add(old_len);
            std::ptr::copy_nonoverlapping(entry.cached_head.as_ptr(), dst, h_len);
            std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), dst.add(h_len), l_len);
            std::ptr::copy_nonoverlapping(b"\r\n\r\n".as_ptr(), dst.add(h_len + l_len), 4);
            if b_len > 0 {
                std::ptr::copy_nonoverlapping(body.as_ptr(), dst.add(h_len + l_len + 4), b_len);
            }
            out.set_len(old_len + h_len + l_len + 4 + b_len);
        }
        true
    }
}

/// Write a complete buffered HTTP/1.1 response with arbitrary headers and optional body.
/// Honors bodyless statuses (`204`, `205`, `304`) and explicit `content-length` on `HEAD`.
pub fn write_buffered_response(
    out: &mut Vec<u8>,
    status: u16,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) {
    let mut num = itoa::Buffer::new();
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(num.format(status).as_bytes());
    out.push(b' ');
    out.extend_from_slice(reason_phrase(status).as_bytes());
    out.extend_from_slice(b"\r\n");

    let mut has_cl = false;
    for &(k, v) in headers {
        if k.eq_ignore_ascii_case("transfer-encoding") || k.eq_ignore_ascii_case("date") {
            continue;
        }
        if k.eq_ignore_ascii_case("content-length") {
            // A 205 has no body whatever the caller declared; its length is written below.
            if status == 205 {
                continue;
            }
            has_cl = true;
        }
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v.as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    date::append_header(out);
    let bodyless = matches!(status, 204 | 205 | 304);
    if status == 205 {
        // Unlike 204 and 304, a 205 is not delimited by the end of its head: an explicit zero length
        // lets a client on a persistent connection finish instead of waiting for EOF.
        out.extend_from_slice(b"content-length: 0\r\n");
    } else if !bodyless && !has_cl {
        let len = body.map_or(0, |b| b.len());
        out.extend_from_slice(b"content-length: ");
        out.extend_from_slice(num.format(len).as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    if !bodyless {
        if let Some(b) = body {
            out.extend_from_slice(b);
        }
    }
}

/// [`write_buffered_response`] for header lines the caller already serialized and validated: each
/// ends in CRLF and none is `date`, `content-length` or `transfer-encoding`. Not for bodyless statuses.
pub fn write_block_response(out: &mut Vec<u8>, status: u16, block: &[u8], body: &[u8]) {
    let mut num = itoa::Buffer::new();
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(num.format(status).as_bytes());
    out.push(b' ');
    out.extend_from_slice(reason_phrase(status).as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(block);
    date::append_header(out);
    out.extend_from_slice(b"content-length: ");
    out.extend_from_slice(num.format(body.len()).as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
}

/// Write the HTTP/1.1 head for a streamed response (`Transfer-Encoding: chunked` unless
/// `content_length` is declared).
pub fn write_stream_head(
    out: &mut Vec<u8>,
    status: u16,
    headers: &[(&str, &str)],
    content_length: Option<u64>,
) {
    write_stream_fields(out, status, headers);
    if let Some(cl) = content_length {
        let mut num = itoa::Buffer::new();
        out.extend_from_slice(b"content-length: ");
        out.extend_from_slice(num.format(cl).as_bytes());
        out.extend_from_slice(b"\r\n\r\n");
    } else {
        out.extend_from_slice(b"transfer-encoding: chunked\r\n\r\n");
    }
}

/// Write the head of a streamed response that ends when the connection closes, for an HTTP/1.0
/// peer that knows no chunked framing.
pub fn write_close_delimited_head(out: &mut Vec<u8>, status: u16, headers: &[(&str, &str)]) {
    write_stream_fields(out, status, headers);
    out.extend_from_slice(b"connection: close\r\n\r\n");
}

fn write_stream_fields(out: &mut Vec<u8>, status: u16, headers: &[(&str, &str)]) {
    let mut num = itoa::Buffer::new();
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(num.format(status).as_bytes());
    out.push(b' ');
    out.extend_from_slice(reason_phrase(status).as_bytes());
    out.extend_from_slice(b"\r\n");

    for &(k, v) in headers {
        if k.eq_ignore_ascii_case("transfer-encoding")
            || k.eq_ignore_ascii_case("content-length")
            || k.eq_ignore_ascii_case("date")
        {
            continue;
        }
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v.as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    date::append_header(out);
}

/// Append one HTTP/1.1 chunk (`<hex>\r\n<bytes>\r\n`).
#[inline]
pub fn write_chunk(out: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.is_empty() {
        return;
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut buf = [0u8; 18];
    let mut pos = 16;
    buf[16] = b'\r';
    buf[17] = b'\n';
    let mut n = chunk.len();
    while n > 0 {
        pos -= 1;
        buf[pos] = HEX[n & 0xf];
        n >>= 4;
    }
    out.extend_from_slice(&buf[pos..]);
    out.extend_from_slice(chunk);
    out.extend_from_slice(b"\r\n");
}

/// Append the final HTTP/1.1 zero-length chunk terminator (`0\r\n\r\n`).
#[inline]
pub fn write_chunk_terminator(out: &mut Vec<u8>) {
    out.extend_from_slice(b"0\r\n\r\n");
}

pub fn write_head_prefix(out: &mut Vec<u8>, status: u16, headers: &[(&str, &str)]) {
    let mut num = itoa::Buffer::new();
    out.extend_from_slice(b"HTTP/1.1 ");
    out.extend_from_slice(num.format(status).as_bytes());
    out.push(b' ');
    out.extend_from_slice(reason_phrase(status).as_bytes());
    out.extend_from_slice(b"\r\n");
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("date") {
            continue;
        }
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(v.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
}

#[inline]
pub fn append_content_length_and_body(out: &mut Vec<u8>, body: &[u8]) {
    let mut num = itoa::Buffer::new();
    date::append_header(out);
    out.extend_from_slice(b"content-length: ");
    out.extend_from_slice(num.format(body.len()).as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
}

#[allow(clippy::match_overlapping_arm)] // the class fallbacks follow the assigned codes on purpose
pub fn reason_phrase(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        102 => "Processing",
        103 => "Early Hints",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        208 => "Already Reported",
        226 => "IM Used",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        305 => "Use Proxy",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a Teapot",
        421 => "Misdirected Request",
        422 => "Unprocessable Content",
        423 => "Locked",
        424 => "Failed Dependency",
        425 => "Too Early",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        506 => "Variant Also Negotiates",
        507 => "Insufficient Storage",
        508 => "Loop Detected",
        510 => "Not Extended",
        511 => "Network Authentication Required",
        // A status with no assigned phrase still gets one that matches its class, never a wrong one.
        100..=199 => "Informational",
        200..=299 => "Success",
        300..=399 => "Redirection",
        400..=499 => "Client Error",
        500..=599 => "Server Error",
        _ => "Unknown",
    }
}

/// Packs parsed requests into the persistent `inMeta` (`u32`) and `inData` (`u8`) shared buffers.
pub struct BatchPacker<'a> {
    meta: &'a mut [u32],
    data: &'a mut [u8],
    count: usize,
    data_pos: usize,
}

impl<'a> BatchPacker<'a> {
    pub fn new(meta: &'a mut [u32], data: &'a mut [u8]) -> Self {
        Self {
            meta,
            data,
            count: 0,
            data_pos: 0,
        }
    }

    pub fn count(&self) -> usize {
        self.count
    }

    pub fn push(&mut self, req_id: u32, req: &ParsedRequest<'_>) -> bool {
        let slot_base = self.count * abi::IN_SLOT_U32S;
        if slot_base + abi::IN_SLOT_U32S > self.meta.len() {
            return false;
        }
        let path_bytes = req.path.as_bytes();
        let query_bytes = req.query.as_bytes();
        let body_slice = req.body.as_ref();
        let inline_body = body_slice.len() <= abi::INLINE_BODY_MAX;
        let ct_bytes = req.content_type.unwrap_or_default();
        let needed = path_bytes.len()
            + query_bytes.len()
            + ct_bytes.len()
            + if inline_body { body_slice.len() } else { 0 };
        if self.data_pos + needed > self.data.len() {
            return false;
        }

        let path_off = self.data_pos as u32;
        self.data[self.data_pos..self.data_pos + path_bytes.len()].copy_from_slice(path_bytes);
        self.data_pos += path_bytes.len();

        let query_off = self.data_pos as u32;
        self.data[self.data_pos..self.data_pos + query_bytes.len()].copy_from_slice(query_bytes);
        self.data_pos += query_bytes.len();

        let ct_off = self.data_pos as u32;
        self.data[self.data_pos..self.data_pos + ct_bytes.len()].copy_from_slice(ct_bytes);
        self.data_pos += ct_bytes.len();

        let (body_off, body_len) = if inline_body {
            let off = self.data_pos as u32;
            self.data[self.data_pos..self.data_pos + body_slice.len()].copy_from_slice(body_slice);
            self.data_pos += body_slice.len();
            (off, body_slice.len() as u32)
        } else {
            (abi::LARGE_BODY_SENTINEL, body_slice.len() as u32)
        };

        let mut flags = (req.method_idx as u32) & abi::METHOD_MASK;
        if !body_slice.is_empty() {
            flags |= abi::FLAG_HAS_BODY;
            if body_slice.is_ascii() {
                flags |= abi::FLAG_IS_ASCII_BODY;
            }
        }
        if req.is_ws_upgrade {
            flags |= abi::FLAG_IS_WS_UPGRADE;
        }
        if req.host_valid {
            flags |= abi::FLAG_HOST_VALID;
        }
        if req.over_max_body {
            flags |= abi::FLAG_OVER_MAX_BODY;
        }
        if !inline_body {
            flags |= abi::FLAG_LARGE_BODY;
        }
        if req.is_json_ct {
            flags |= abi::FLAG_CT_JSON;
        }
        if req.content_type.is_some() {
            flags |= abi::FLAG_HAS_CT;
        }
        if req.is_chunked {
            flags |= abi::FLAG_CHUNKED;
        }

        self.meta[slot_base] = req_id;
        self.meta[slot_base + 1] = flags;
        self.meta[slot_base + 2] = path_off;
        self.meta[slot_base + 3] = path_bytes.len() as u32;
        self.meta[slot_base + 4] = query_off;
        self.meta[slot_base + 5] = query_bytes.len() as u32;
        self.meta[slot_base + 6] = body_off;
        self.meta[slot_base + 7] = body_len;
        self.meta[slot_base + 8] = ct_off;
        self.meta[slot_base + 9] = ct_bytes.len() as u32;

        self.count += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_smuggling_headers() {
        let dup_host = b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n";
        assert_eq!(
            parse_http1(dup_host, ParseLimits::default()).unwrap_err(),
            ParseError::DuplicateHost
        );

        let cl_te = b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\ntest";
        assert_eq!(
            parse_http1(cl_te, ParseLimits::default()).unwrap_err(),
            ParseError::ContentLengthWithTransferEncoding
        );

        let signed_cl = b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: +4\r\n\r\ntest";
        assert_eq!(
            parse_http1(signed_cl, ParseLimits::default()).unwrap_err(),
            ParseError::Malformed
        );

        let mut huge_hdr = b"GET / HTTP/1.1\r\nHost: a\r\nX-Pad: ".to_vec();
        huge_hdr.resize(128, b'a');
        let small_hdr = ParseLimits {
            max_header_bytes: 64,
            ..ParseLimits::default()
        };
        assert_eq!(
            parse_http1(&huge_hdr, small_hdr).unwrap_err(),
            ParseError::HeadersTooLarge
        );
    }

    #[test]
    fn decodes_chunked_request_and_enforces_cap() {
        let raw = b"POST /upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n5;ext=1\r\n{\"a\":\r\n2\r\n1}\r\n0\r\nX-Trailer: ok\r\n\r\n";
        let ParseStatus::Complete(parsed) = parse_http1(raw, ParseLimits::default()).unwrap()
        else {
            panic!("expected complete chunked request");
        };
        assert!(parsed.is_chunked);
        assert!(parsed.is_json_ct);
        assert_eq!(parsed.body.as_ref(), br#"{"a":1}"#);
        assert_eq!(parsed.total_bytes, raw.len());

        let tiny = ParseLimits {
            max_body_size: 4,
            oversize_window: 0,
            max_header_bytes: 64 * 1024,
            ..ParseLimits::default()
        };
        assert_eq!(
            parse_http1(raw, tiny).unwrap_err(),
            ParseError::PayloadTooLarge
        );
    }

    fn complete(raw: &[u8]) -> Result<bool, ParseError> {
        parse_http1(raw, ParseLimits::default()).map(|s| matches!(s, ParseStatus::Complete(_)))
    }

    #[test]
    fn chunk_sizes_are_strict_hex() {
        let wrap = |size: &str| {
            format!(
                "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n{size}\r\nhello\r\n0\r\n\r\n"
            )
        };
        for ok in ["5", "05", "5;ext=1", "5 ;ext=1", "5\t;ext"] {
            assert_eq!(complete(wrap(ok).as_bytes()), Ok(true), "{ok:?}");
        }
        for bad in [
            "+5",
            " 5",
            "5 ",
            "0x5",
            "-5",
            "",
            ";ext",
            "5\rX",
            "ffffffffffffffffff",
        ] {
            assert_eq!(
                complete(wrap(bad).as_bytes()),
                Err(ParseError::Malformed),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn chunked_framing_and_lines_are_bounded() {
        let head = b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n";
        // A size line that never ends is refused once it passes the line cap, not buffered forever.
        let mut endless = head.to_vec();
        endless.extend_from_slice(b"1;");
        endless.resize(endless.len() + MAX_CHUNK_LINE + 1, b'a');
        assert_eq!(complete(&endless), Err(ParseError::Malformed));
        // So is a trailer section that never ends.
        let mut trailers = head.to_vec();
        trailers.extend_from_slice(b"0\r\n");
        trailers.resize(trailers.len() + MAX_CHUNK_TRAILERS + 1, b'a');
        assert_eq!(complete(&trailers), Err(ParseError::Malformed));
        // Many tiny chunks with fat extensions stay inside the decoded cap but not the framing cap.
        let limits = ParseLimits {
            max_body_size: 1024,
            oversize_window: 1024,
            max_header_bytes: 1024,
            ..ParseLimits::default()
        };
        let mut fat = head.to_vec();
        for _ in 0..200 {
            fat.extend_from_slice(b"1;");
            fat.resize(fat.len() + 100, b'a');
            fat.extend_from_slice(b"\r\nX\r\n");
        }
        assert_eq!(
            parse_http1(&fat, limits).unwrap_err(),
            ParseError::PayloadTooLarge
        );
    }

    #[test]
    fn resumed_chunked_decode_matches_one_shot_and_is_linear() {
        let head = b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n";
        let mut wire = head.to_vec();
        let mut expected = Vec::new();
        for i in 0..4000u32 {
            let byte = b'a' + (i % 26) as u8;
            wire.extend_from_slice(b"1\r\n");
            wire.push(byte);
            wire.extend_from_slice(b"\r\n");
            expected.push(byte);
        }
        wire.extend_from_slice(b"0\r\nx-trailer: 1\r\n\r\n");

        let mut resume = ChunkResume::default();
        let mut finished = None;
        for end in 1..=wire.len() {
            match parse_http1_resume(&wire[..end], ParseLimits::default(), &mut resume).unwrap() {
                ParseStatus::Incomplete => {}
                ParseStatus::Complete(req) => {
                    finished = Some((req.body.into_owned(), req.total_bytes));
                    break;
                }
                ParseStatus::StreamHead(_) => panic!("unexpected StreamHead when disabled"),
            }
        }
        let (body, total) = finished.expect("complete once every byte has arrived");
        assert_eq!(body, expected);
        assert_eq!(total, wire.len());
        // Fed a byte at a time, each byte is looked at a bounded number of times - not once per
        // arrival of every later byte.
        assert!(
            resume.examined() < 16 * wire.len() as u64,
            "examined {} bytes for a {}-byte request",
            resume.examined(),
            wire.len()
        );
        // Control: restarting the decode on every arrival, as `parse_http1` alone would, trips the same
        // gauge - so the bound above is measuring the resume, not a loose threshold.
        let mut restarted = 0u64;
        for end in (1..=wire.len()).step_by(7) {
            let mut fresh = ChunkResume::default();
            let _ = parse_http1_resume(&wire[..end], ParseLimits::default(), &mut fresh);
            restarted += fresh.examined();
        }
        assert!(
            restarted > 16 * wire.len() as u64,
            "control examined only {restarted}"
        );
    }

    #[test]
    fn connection_header_is_a_token_list() {
        let keep_alive = |value: &str| {
            let raw = format!("GET / HTTP/1.1\r\nHost: a\r\nConnection: {value}\r\n\r\n");
            let Ok(ParseStatus::Complete(req)) =
                parse_http1(raw.as_bytes(), ParseLimits::default())
            else {
                panic!("expected a complete request");
            };
            req.keep_alive
        };
        assert!(!keep_alive("close"));
        assert!(!keep_alive("keep-alive, close"));
        assert!(!keep_alive("Upgrade, Close"));
        assert!(keep_alive("keep-alive"));
        assert!(keep_alive("TE"));
    }

    #[test]
    fn connection_tokens_accumulate_across_repeated_fields() {
        let keep_alive = |fields: &str| {
            let raw = format!("GET / HTTP/1.1\r\nHost: a\r\n{fields}\r\n");
            let Ok(ParseStatus::Complete(req)) =
                parse_http1(raw.as_bytes(), ParseLimits::default())
            else {
                panic!("expected a complete request");
            };
            req.keep_alive
        };
        assert!(!keep_alive(
            "Connection: close\r\nConnection: keep-alive\r\n"
        ));
        assert!(!keep_alive(
            "Connection: keep-alive\r\nConnection: close\r\n"
        ));
        assert!(keep_alive("Connection: TE\r\nConnection: keep-alive\r\n"));
    }

    #[test]
    fn a_trailer_section_split_across_reads_is_scanned_once() {
        let mut wire =
            b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n"
                .to_vec();
        for i in 0..40 {
            wire.extend_from_slice(format!("x-trailer-{i}: value-{i}\r\n").as_bytes());
        }
        wire.extend_from_slice(b"\r\n");
        let mut resume = ChunkResume::default();
        let mut done = false;
        for end in 1..=wire.len() {
            if let ParseStatus::Complete(req) =
                parse_http1_resume(&wire[..end], ParseLimits::default(), &mut resume).unwrap()
            {
                assert_eq!(req.body.as_ref(), b"x");
                assert_eq!(req.total_bytes, wire.len());
                done = true;
                break;
            }
        }
        assert!(done);
        assert!(
            resume.examined() < 8 * wire.len() as u64,
            "examined {} bytes for a {}-byte request",
            resume.examined(),
            wire.len()
        );
    }

    #[test]
    fn block_response_matches_the_pair_writer() {
        let mut pairs = Vec::new();
        write_buffered_response(
            &mut pairs,
            201,
            &[("x-a", "1"), ("x-b", "a: b")],
            Some(b"hi"),
        );
        let mut block = Vec::new();
        write_block_response(&mut block, 201, b"x-a: 1\r\nx-b: a: b\r\n", b"hi");
        assert_eq!(block, pairs);
    }

    #[test]
    fn a_205_declares_a_zero_length_and_no_body() {
        let mut out = Vec::new();
        write_buffered_response(&mut out, 205, &[("content-length", "9")], Some(b"ignored"));
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 205 Reset Content\r\n"));
        assert_eq!(text.matches("content-length").count(), 1);
        assert!(text.contains("content-length: 0\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn a_static_reply_carries_the_date_of_the_hit() {
        let mut routes = FastRoutes::default();
        routes.add_static_get(
            "/ok".to_owned(),
            200,
            &[("content-type", "text/plain")],
            b"ok",
        );
        let mut out = Vec::new();
        assert!(routes.try_match_get("/ok", &mut out));
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches("date: ").count(), 1, "{text}");
        assert!(text.ends_with("content-length: 2\r\n\r\nok"));
    }

    #[test]
    fn reason_phrases_match_their_status() {
        assert_eq!(reason_phrase(302), "Found");
        assert_eq!(reason_phrase(404), "Not Found");
        assert_eq!(reason_phrase(405), "Method Not Allowed");
        assert_eq!(reason_phrase(502), "Bad Gateway");
        // Unassigned codes get their class, not "OK".
        assert_eq!(reason_phrase(299), "Success");
        assert_eq!(reason_phrase(499), "Client Error");
        assert_eq!(reason_phrase(599), "Server Error");
        assert_eq!(reason_phrase(999), "Unknown");
        let mut out = Vec::new();
        write_buffered_response(&mut out, 302, &[("location", "/x")], None);
        assert!(out.starts_with(b"HTTP/1.1 302 Found\r\n"));
    }

    #[test]
    fn lazy_header_lookup_and_chunked_framing() {
        let head = b"GET /test HTTP/1.1\r\nHost: example.com\r\nX-Custom: a\r\nX-Custom: b\r\nContent-Type: text/plain\r\nContent-Type: application/json\r\n\r\n";
        assert_eq!(
            collect_headers_in_head(head),
            [
                "host",
                "example.com",
                "x-custom",
                "a",
                "x-custom",
                "b",
                "content-type",
                "text/plain",
                "content-type",
                "application/json",
            ]
        );

        let mut out = Vec::new();
        write_stream_head(
            &mut out,
            200,
            &[("content-type", "text/event-stream")],
            None,
        );
        write_chunk(&mut out, b"hello");
        write_chunk_terminator(&mut out);
        let text = String::from_utf8(out).unwrap();
        let (head, rest) = text.split_once("\r\n\r\n").unwrap();
        let lines: Vec<&str> = head.split("\r\n").collect();
        assert_eq!(lines[0], "HTTP/1.1 200 OK");
        assert_eq!(lines[1], "content-type: text/event-stream");
        assert!(lines[2].starts_with("date: ") && lines[2].ends_with(" GMT"));
        assert_eq!(lines[3], "transfer-encoding: chunked");
        assert_eq!(rest, "5\r\nhello\r\n0\r\n\r\n");
    }

    #[test]
    fn matches_param_fast_route_and_packs_batch() {
        let mut routes = FastRoutes::default();
        routes.add_param_get(
            "/user/".into(),
            "".into(),
            200,
            &[("content-type", "text/plain")],
        );
        let mut out = Vec::new();
        assert!(routes.try_match_get("/user/42", &mut out));
        assert!(out.ends_with(b"content-length: 2\r\n\r\n42"));

        let raw = b"POST /users?a=1 HTTP/1.1\r\nHost: localhost:3000\r\nContent-Length: 11\r\n\r\n{\"id\":\"42\"}";
        let ParseStatus::Complete(parsed) = parse_http1(raw, ParseLimits::default()).unwrap()
        else {
            panic!("expected complete");
        };
        let mut meta = [0u32; 16];
        let mut data = [0u8; 256];
        let mut packer = BatchPacker::new(&mut meta, &mut data);
        assert!(packer.push(7, &parsed));
        assert_eq!(packer.count(), 1);
        assert_eq!(meta[0], 7);
        assert_eq!(meta[1] & abi::METHOD_MASK, 1);
        assert_ne!(meta[1] & abi::FLAG_HOST_VALID, 0);
        assert_ne!(meta[1] & abi::FLAG_IS_ASCII_BODY, 0);
    }

    #[test]
    fn batch_slots_carry_the_first_content_type() {
        let cases: [(&[u8], Option<&str>); 4] = [
            (
                b"POST /u HTTP/1.1\r\nHost: h\r\nContent-Type:   application/json; charset=utf-8  \r\nContent-Length: 2\r\n\r\n{}",
                Some("application/json; charset=utf-8"),
            ),
            (
                b"POST /u HTTP/1.1\r\nHost: h\r\nContent-Type: text/plain\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
                Some("text/plain"),
            ),
            (
                b"POST /u HTTP/1.1\r\nHost: h\r\nContent-Type:\r\nContent-Length: 2\r\n\r\n{}",
                Some(""),
            ),
            (
                b"POST /u HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n\r\n{}",
                None,
            ),
        ];
        for (raw, expected) in cases {
            let ParseStatus::Complete(parsed) = parse_http1(raw, ParseLimits::default()).unwrap()
            else {
                panic!("expected complete");
            };
            let mut meta = [0u32; abi::IN_SLOT_U32S];
            let mut data = [0u8; 256];
            let mut packer = BatchPacker::new(&mut meta, &mut data);
            assert!(packer.push(1, &parsed));
            assert_eq!(meta[1] & abi::FLAG_HAS_CT != 0, expected.is_some());
            let (off, len) = (meta[8] as usize, meta[9] as usize);
            match expected {
                Some(value) => assert_eq!(&data[off..off + len], value.as_bytes()),
                None => assert_eq!(len, 0),
            }
            // The body still lands where its own slot says, after the content type.
            let (body_off, body_len) = (meta[6] as usize, meta[7] as usize);
            assert_eq!(&data[body_off..body_off + body_len], b"{}");
        }
    }

    #[test]
    fn a_full_batch_refuses_instead_of_overrunning_for_a_long_content_type() {
        let raw = b"POST /u HTTP/1.1\r\nHost: h\r\nContent-Type: application/vnd.example+json\r\nContent-Length: 2\r\n\r\n{}";
        let ParseStatus::Complete(parsed) = parse_http1(raw, ParseLimits::default()).unwrap()
        else {
            panic!("expected complete");
        };
        let mut meta = [0u32; abi::IN_SLOT_U32S];
        // Room for the path and body but not the content type.
        let mut data = [0u8; 8];
        let mut packer = BatchPacker::new(&mut meta, &mut data);
        assert!(!packer.push(1, &parsed));
        assert_eq!(packer.count(), 0);
    }

    #[test]
    fn classifies_json_media_types_without_slicing_utf8() {
        for (media_type, expected) in [
            ("application/json", true),
            ("APPLICATION/JSON ; charset=utf-8", true),
            ("application/json-seq", false),
            ("application/x-café", false),
        ] {
            let input =
                format!("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: {media_type}\r\n\r\n");
            let ParseStatus::Complete(request) =
                parse_http1(input.as_bytes(), ParseLimits::default()).unwrap()
            else {
                panic!("expected a complete request");
            };
            assert_eq!(request.is_json_ct, expected);
        }
    }

    #[test]
    fn validates_bracketed_addresses_and_decimal_ports() {
        for host in [
            "localhost",
            "app_test.local:443",
            "[::1]",
            "[2001:db8::1]:65535",
        ] {
            assert!(is_valid_host(host), "{host}");
        }
        for host in [
            "[::1:]",
            "[::1]trailing",
            "localhost:+80",
            "localhost:65536",
            "hostname?",
        ] {
            assert!(!is_valid_host(host), "{host}");
        }
    }

    fn parse_one(wire: &[u8]) -> Result<bool, ParseError> {
        parse_http1(wire, ParseLimits::default())
            .map(|status| matches!(status, ParseStatus::Complete(_)))
    }

    #[test]
    fn refuses_what_proxies_and_servers_read_differently() {
        for wire in [
            &b"GET / HTTP/1.1\nHost: a\n\n"[..],
            b"GET / HTTP/1.1\r\nHost: a\n\r\n",
            b"GET @evil.test/x HTTP/1.1\r\nHost: a\r\n\r\n",
            b"GET * HTTP/1.1\r\nHost: a\r\n\r\n",
            b"GET / HTTP/1.1\r\nHost: \xe9\r\n\r\n",
        ] {
            assert_eq!(parse_one(wire), Err(ParseError::Malformed), "{wire:?}");
        }
        assert_eq!(
            parse_one(b"GET / HTTP/1.1\r\n\r\n"),
            Err(ParseError::MissingHost)
        );
        for wire in [
            &b"GET / HTTP/1.0\r\n\r\n"[..],
            b"OPTIONS * HTTP/1.1\r\nHost: a\r\n\r\n",
            b"GET http://a/x HTTP/1.1\r\nHost: a\r\n\r\n",
        ] {
            assert_eq!(parse_one(wire), Ok(true), "{wire:?}");
        }
    }

    #[test]
    fn takes_many_fields_and_latin1_values() {
        let mut wire = b"GET / HTTP/1.1\r\nHost: a\r\nx-raw: \xe9\r\n".to_vec();
        for i in 0..200 {
            wire.extend_from_slice(format!("x-{i}: 1\r\n").as_bytes());
        }
        wire.extend_from_slice(b"\r\n");
        assert_eq!(parse_one(&wire), Ok(true));
        let fields = collect_headers_in_head(&wire);
        assert_eq!(fields.len(), 2 * 202);
        assert_eq!(fields[3], "\u{e9}");
    }

    #[test]
    fn bounds_the_head_at_16_kib() {
        let mut wire = b"GET / HTTP/1.1\r\nHost: a\r\nx-big: ".to_vec();
        wire.resize(wire.len() + 8_000, b'a');
        assert_eq!(parse_one(&wire), Ok(false));
        wire.resize(wire.len() + 10_000, b'a');
        assert_eq!(parse_one(&wire), Err(ParseError::HeadersTooLarge));
    }

    #[test]
    fn sees_expect_continue_once_the_head_is_in() {
        let head =
            b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\nExpect: 100-Continue\r\n\r\n";
        assert_eq!(awaits_continue(head), Some(true));
        assert_eq!(awaits_continue(&head[..30]), None);
        // The same field capacity as the request parser.
        let mut many = b"POST / HTTP/1.1\r\nHost: a\r\n".to_vec();
        for i in 0..MAX_HEADERS * 2 {
            many.extend_from_slice(format!("X-{i}: v\r\n").as_bytes());
        }
        many.extend_from_slice(b"Content-Length: 3\r\nExpect: 100-continue\r\n\r\n");
        assert_eq!(awaits_continue(&many), Some(true));
        assert_eq!(
            awaits_continue(b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\n"),
            Some(false)
        );
    }

    #[test]
    fn enforces_max_uri_size_and_max_headers() {
        let uri_limits = ParseLimits {
            max_uri_size: 16,
            ..ParseLimits::default()
        };
        assert_eq!(
            parse_http1(
                b"GET /0123456789abcdef HTTP/1.1\r\nHost: a\r\n\r\n",
                uri_limits
            )
            .unwrap_err(),
            ParseError::UriTooLarge
        );
        // Enforced early on incomplete requests too.
        assert_eq!(
            parse_http1(b"GET /0123456789abcdef", uri_limits).unwrap_err(),
            ParseError::UriTooLarge
        );
        assert!(matches!(
            parse_http1(b"GET /ok HTTP/1.1\r\nHost: a\r\n\r\n", uri_limits),
            Ok(ParseStatus::Complete(_))
        ));

        let hdr_limits = ParseLimits {
            max_headers: 3,
            ..ParseLimits::default()
        };
        assert!(matches!(
            parse_http1(
                b"GET / HTTP/1.1\r\nHost: a\r\nX-1: 1\r\nX-2: 2\r\n\r\n",
                hdr_limits
            ),
            Ok(ParseStatus::Complete(_))
        ));
        assert_eq!(
            parse_http1(
                b"GET / HTTP/1.1\r\nHost: a\r\nX-1: 1\r\nX-2: 2\r\nX-3: 3\r\n\r\n",
                hdr_limits
            )
            .unwrap_err(),
            ParseError::HeadersTooLarge
        );

        // Above default 64 stack cap still succeeds dynamically up to configured limit.
        let high_hdr_limits = ParseLimits {
            max_headers: 80,
            ..ParseLimits::default()
        };
        let mut req_bytes = b"GET / HTTP/1.1\r\nHost: a\r\n".to_vec();
        for i in 0..70 {
            req_bytes.extend_from_slice(format!("X-H-{i}: v\r\n").as_bytes());
        }
        req_bytes.extend_from_slice(b"\r\n");
        assert!(matches!(
            parse_http1(&req_bytes, high_hdr_limits),
            Ok(ParseStatus::Complete(_))
        ));
    }

    #[test]
    fn streaming_head_and_body_decoder_handle_fixed_chunked_and_large_lengths() {
        let limits = ParseLimits {
            max_body_size: 4,
            stream_request_bodies: true,
            ..ParseLimits::default()
        };

        // 5 GiB Content-Length parses without overflow and yields StreamHead immediately.
        let five_gib = "POST /upload HTTP/1.1\r\nHost: a\r\nContent-Length: 5368709120\r\n\r\nabc";
        match parse_http1(five_gib.as_bytes(), limits).unwrap() {
            ParseStatus::StreamHead(head) => {
                assert_eq!(head.path, "/upload");
                assert_eq!(head.content_length, Some(5_368_709_120));
                assert!(!head.is_chunked);
                let mut dec = H1BodyDecoder::fixed(head.content_length.unwrap());
                let step = dec.feed(&five_gib.as_bytes()[head.head_len..]).unwrap();
                assert_eq!(step.chunk, b"abc");
                assert!(!step.done);
            }
            other => panic!("expected StreamHead, got {other:?}"),
        }

        // Chunked request yields StreamHead and decodes incremental slices.
        let raw_chunked =
            b"POST /chunks HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nfoo\r\n4\r\nbar!\r\n0\r\nX-Tr: 1\r\n\r\n";
        let head = match parse_http1(raw_chunked, limits).unwrap() {
            ParseStatus::StreamHead(h) => h,
            other => panic!("expected StreamHead, got {other:?}"),
        };
        assert!(head.is_chunked);
        let mut dec = H1BodyDecoder::chunked();
        let mut rest = &raw_chunked[head.head_len..];
        let mut collected = Vec::new();
        loop {
            let step = dec.feed(rest).unwrap();
            collected.extend_from_slice(step.chunk);
            rest = &rest[step.consumed..];
            if step.done {
                break;
            }
        }
        assert_eq!(collected, b"foobar!");
        assert!(rest.is_empty());
    }

    #[test]
    fn fast_routes_match_static_post_without_cross_matching_get() {
        let mut routes = FastRoutes::default();
        routes.add_static_post(
            "/ping".into(),
            200,
            &[("content-type", "text/plain")],
            b"pong",
        );
        let mut out = Vec::new();
        assert!(!routes.try_match_get("/ping", &mut out));
        assert!(routes.try_match_post("/ping", &mut out));
        let text = std::str::from_utf8(&out).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.ends_with("pong"));
    }
}
