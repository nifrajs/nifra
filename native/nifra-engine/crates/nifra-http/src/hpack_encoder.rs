//! HPACK encoding for response fields (RFC 7541).
//!
//! The dynamic table is shared with the peer's decoder, so every block encoded here must reach the
//! wire, in the order it was encoded.

use std::collections::VecDeque;

use crate::h2::{encode_hpack_int, HUFFMAN_TABLE, STATIC_TABLE};

/// What a peer's table holds until its `SETTINGS_HEADER_TABLE_SIZE` says otherwise.
const PEER_DEFAULT_TABLE: usize = 4096;

pub(crate) struct HpackEncoder {
    /// Newest first.
    dynamic: VecDeque<(Box<str>, Box<[u8]>)>,
    size: usize,
    max_size: usize,
    cap: usize,
    /// The smallest size the table took since the last block, when it changed.
    resized_to: Option<usize>,
}

/// A secret: never indexed, here or by an intermediary (RFC 7541 section 7.1).
fn is_sensitive(name: &str) -> bool {
    matches!(
        name,
        "set-cookie" | "cookie" | "authorization" | "proxy-authorization"
    )
}

/// Rarely the same twice, so an entry would only push a useful one out.
fn is_volatile(name: &str) -> bool {
    matches!(
        name,
        "content-length"
            | "content-range"
            | "etag"
            | "last-modified"
            | "location"
            | "age"
            | "expires"
    )
}

/// First static table index of a name a response carries. A name missing here is still encoded
/// correctly, as a literal; a scan of the whole table per field costs more than the bytes it saves.
fn static_name(name: &str) -> Option<usize> {
    Some(match name {
        ":status" => 8,
        "accept-ranges" => 18,
        "access-control-allow-origin" => 20,
        "age" => 21,
        "allow" => 22,
        "cache-control" => 24,
        "content-disposition" => 25,
        "content-encoding" => 26,
        "content-language" => 27,
        "content-length" => 28,
        "content-location" => 29,
        "content-range" => 30,
        "content-type" => 31,
        "date" => 33,
        "etag" => 34,
        "expires" => 36,
        "last-modified" => 44,
        "link" => 45,
        "location" => 46,
        "retry-after" => 53,
        "server" => 54,
        "set-cookie" => 55,
        "strict-transport-security" => 56,
        "vary" => 59,
        "via" => 60,
        "www-authenticate" => 61,
        _ => return None,
    })
}

fn encode_string(bytes: &[u8], out: &mut Vec<u8>) {
    let bits: usize = bytes
        .iter()
        .map(|&b| usize::from(HUFFMAN_TABLE[usize::from(b)].1))
        .sum();
    let packed = bits.div_ceil(8);
    if packed >= bytes.len() {
        encode_hpack_int(bytes.len(), 7, 0x00, out);
        out.extend_from_slice(bytes);
        return;
    }
    encode_hpack_int(packed, 7, 0x80, out);
    // Only the low `held` bits are pending; the ones above them are already written.
    let mut pending = 0u64;
    let mut held = 0u32;
    for &byte in bytes {
        let (code, len) = HUFFMAN_TABLE[usize::from(byte)];
        pending = (pending << len) | u64::from(code);
        held += u32::from(len);
        while held >= 8 {
            held -= 8;
            out.push((pending >> held) as u8);
        }
    }
    if held > 0 {
        // Padded with the high bits of EOS, which are all ones.
        out.push(((pending << (8 - held)) as u8) | (0xff >> held));
    }
}

fn literal(
    mask: u8,
    prefix_bits: u8,
    name_index: Option<usize>,
    name: &str,
    value: &[u8],
    out: &mut Vec<u8>,
) {
    match name_index {
        Some(index) => encode_hpack_int(index, prefix_bits, mask, out),
        None => {
            out.push(mask);
            encode_string(name.as_bytes(), out);
        }
    }
    encode_string(value, out);
}

/// A literal that leaves the table alone, for a block that is written later than it is encoded.
pub(crate) fn encode_stateless(name: &str, value: &[u8], out: &mut Vec<u8>) {
    let name_index = static_name(name);
    let mask = if is_sensitive(name) { 0x10 } else { 0x00 };
    literal(mask, 4, name_index, name, value, out);
}

impl HpackEncoder {
    /// `cap` bounds the memory this side spends on the table, whatever the peer allows.
    pub(crate) fn new(cap: usize) -> Self {
        let max_size = cap.min(PEER_DEFAULT_TABLE);
        Self {
            dynamic: VecDeque::new(),
            size: 0,
            max_size,
            cap,
            resized_to: (max_size < PEER_DEFAULT_TABLE).then_some(max_size),
        }
    }

    pub(crate) fn set_peer_max(&mut self, peer: usize) {
        let max_size = peer.min(self.cap);
        if max_size == self.max_size {
            return;
        }
        self.resized_to = Some(self.resized_to.map_or(max_size, |low| low.min(max_size)));
        self.max_size = max_size;
        self.evict(max_size);
    }

    fn evict(&mut self, limit: usize) {
        while self.size > limit {
            match self.dynamic.pop_back() {
                Some((name, value)) => self.size -= name.len() + value.len() + 32,
                None => self.size = 0,
            }
        }
    }

    /// Open a header block. A size change must lead it (RFC 7541 section 4.2).
    pub(crate) fn begin(&mut self, out: &mut Vec<u8>) {
        let Some(low) = self.resized_to.take() else {
            return;
        };
        if low < self.max_size {
            encode_hpack_int(low, 5, 0x20, out);
        }
        encode_hpack_int(self.max_size, 5, 0x20, out);
    }

    /// Append one field. `name` must already be lower-case.
    pub(crate) fn field(&mut self, name: &str, value: &[u8], out: &mut Vec<u8>) {
        let mut name_index = static_name(name);
        if let Some(first) = name_index {
            // Entries sharing a name are adjacent; only some carry a value.
            for (at, &(entry, held)) in STATIC_TABLE.iter().enumerate().skip(first - 1) {
                if entry != name {
                    break;
                }
                if !held.is_empty() && held.as_bytes() == value {
                    encode_hpack_int(at + 1, 7, 0x80, out);
                    return;
                }
            }
        }
        let sensitive = is_sensitive(name);
        for (at, (entry, held)) in self.dynamic.iter().enumerate() {
            if **entry == *name {
                if !sensitive && **held == *value {
                    encode_hpack_int(STATIC_TABLE.len() + 1 + at, 7, 0x80, out);
                    return;
                }
                name_index.get_or_insert(STATIC_TABLE.len() + 1 + at);
            }
        }
        let size = name.len() + value.len() + 32;
        if sensitive {
            literal(0x10, 4, name_index, name, value, out);
        } else if is_volatile(name) || size > self.max_size / 2 {
            literal(0x00, 4, name_index, name, value, out);
        } else {
            literal(0x40, 6, name_index, name, value, out);
            self.evict(self.max_size - size);
            self.dynamic.push_front((name.into(), value.into()));
            self.size += size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_names_point_at_their_first_table_entry() {
        for (at, &(name, _)) in STATIC_TABLE.iter().enumerate() {
            if let Some(index) = static_name(name) {
                let first = STATIC_TABLE.iter().position(|&(n, _)| n == name);
                assert_eq!(Some(index - 1), first, "{name} at {at}");
            }
        }
    }
}
