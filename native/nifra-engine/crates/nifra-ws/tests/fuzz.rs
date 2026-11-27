//! Hostile bytes into the WebSocket frame decoder, with and without `permessage-deflate`.

#[path = "../../nifra-http/tests/support/mod.rs"]
mod support;

use nifra_ws::{NegotiatedDeflate, WsConn};
use support::{deliver, mutate, run};

fn frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first];
    if payload.len() < 126 {
        out.push(0x80 | payload.len() as u8);
    } else {
        out.push(0x80 | 126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    }
    // An all-zero mask leaves the payload readable to the mutator.
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(payload);
    out
}

#[test]
fn websocket_frames_never_panic_the_decoder() {
    let pieces = vec![
        frame(0x81, b"hello"),
        frame(0x01, b"frag"),
        frame(0x80, b"ment"),
        frame(0x82, &[7; 300]),
        frame(0x89, b"ping"),
        frame(0x8a, b""),
        frame(0x88, &[0x03, 0xe8, b'o', b'k']),
        frame(0xc1, &[0xf2, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00]),
        frame(0xc2, &[0x03, 0x00, 0x03, 0x00, 0x00]),
        frame(0x41, &[0xf2, 0x48]),
        vec![0x82, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    ];
    let mut events = 0u64;
    run(|rng| {
        let input = mutate(rng, &pieces);
        let negotiated = NegotiatedDeflate {
            header_value: String::new(),
            server_no_context_takeover: rng.below(2) == 0,
            client_no_context_takeover: rng.below(2) == 0,
            server_max_window_bits: 9 + rng.below(7) as u8,
            client_max_window_bits: 9 + rng.below(7) as u8,
            threshold: rng.below(64),
            max_decompressed_size: rng.below(2048),
            level: 1 + rng.below(9) as u8,
            shared_compressor: false,
        };
        let deflate = (rng.below(2) == 0).then_some(&negotiated);
        let mut conn = WsConn::with_deflate(64 + rng.below(4096), deflate);
        let mut out = Vec::new();
        deliver(rng, &input, |buffer| {
            let result = conn.feed(buffer, &mut out);
            events += result.events.len() as u64;
            (result.consumed, !result.close_after_write)
        });
    });
    assert!(events > support::cases() / 20, "only {events} messages");
}
