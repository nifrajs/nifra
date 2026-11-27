//! Hostile bytes into the HTTP/1.1 parser, the chunked decoder and the HTTP/2 connection.

mod support;

use nifra_http::h2::{H2Config, H2Conn, CLIENT_PREFACE};
use nifra_http::{parse_http1, H1BodyDecoder, ParseLimits, ParseStatus};
use support::{deliver, mutate, run};

fn frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = (payload.len() as u32).to_be_bytes()[1..].to_vec();
    out.push(kind);
    out.push(flags);
    out.extend_from_slice(&stream.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[test]
fn http1_requests_never_panic_the_parser() {
    let pieces: Vec<Vec<u8>> = [
        "GET / HTTP/1.1\r\nHost: h\r\n\r\n",
        "POST /a?b=c HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\nbody",
        "POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n",
        "4;x=y\r\nbody\r\n0\r\nx-trailer: 1\r\n\r\n",
        "ffffffffffffffff\r\n",
        "Expect: 100-continue\r\n",
        "Upgrade: websocket\r\nConnection: Upgrade\r\n",
        "OPTIONS * HTTP/1.0\r\n\r\n",
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect();
    let mut parsed = 0u64;
    run(|rng| {
        let input = mutate(rng, &pieces);
        let limits = ParseLimits {
            max_body_size: rng.below(4096),
            oversize_window: rng.below(4096),
            max_header_bytes: 64 + rng.below(4096),
            max_headers: rng.below(8),
            max_uri_size: rng.below(64),
            stream_request_bodies: rng.below(2) == 0,
        };
        deliver(rng, &input, |buffer| match parse_http1(buffer, limits) {
            Ok(ParseStatus::Complete(request)) => {
                parsed += 1;
                (request.total_bytes, true)
            }
            Ok(_) => (0, true),
            Err(_) => (0, false),
        });
        for mut decoder in [
            H1BodyDecoder::chunked(),
            H1BodyDecoder::fixed(rng.next() % 4096),
        ] {
            deliver(rng, &input, |buffer| match decoder.feed(buffer) {
                Ok(step) => (step.consumed, !step.done),
                Err(_) => (0, false),
            });
        }
    });
    // A fuzzer whose inputs are all refused at the first byte proves nothing.
    assert!(
        parsed > support::cases() / 20,
        "only {parsed} requests parsed"
    );
}

#[test]
fn http2_frames_never_panic_the_connection() {
    // `:method GET`, `:scheme http`, `:path /`, `:authority localhost`.
    let mut block = vec![0x82, 0x86, 0x84, 0x41, 0x09];
    block.extend_from_slice(b"localhost");
    let mut start = CLIENT_PREFACE.to_vec();
    start.extend(frame(4, 0, 0, &[]));
    let pieces = vec![
        frame(1, 0x5, 1, &block),
        frame(1, 0x4, 3, &block),
        frame(1, 0x0, 5, &block[..4]),
        frame(9, 0x4, 5, &block[4..]),
        frame(0, 0x1, 3, b"body"),
        frame(0, 0x9, 3, &[2, b'x', 0, 0]),
        frame(2, 0, 7, &[0, 0, 0, 7, 16]),
        frame(3, 0, 3, &[0, 0, 0, 8]),
        frame(
            4,
            0,
            0,
            &[0, 4, 0x7f, 0xff, 0xff, 0xff, 0, 5, 0, 0, 0x40, 0],
        ),
        frame(4, 1, 0, &[]),
        frame(6, 0, 0, &[0; 8]),
        frame(7, 0, 0, &[0; 8]),
        frame(8, 0, 0, &[0x7f, 0xff, 0xff, 0xff]),
        frame(8, 0, 1, &[0, 0, 0, 1]),
        frame(1, 0x25, 9, &[&[0x80, 0, 0, 9, 8][..], &block].concat()),
        vec![0x20, 0x3f, 0xe1, 0xff, 0xff, 0xff],
    ];
    let mut events = 0u64;
    run(|rng| {
        let mut input = if rng.below(20) == 0 {
            Vec::new()
        } else {
            start.clone()
        };
        input.extend(mutate(rng, &pieces));
        let mut conn = H2Conn::new(H2Config::default());
        let mut out = Vec::new();
        deliver(rng, &input, |buffer| {
            let result = conn.feed(buffer, &mut out);
            events += result.events.len() as u64;
            (result.consumed, !result.close_after_write)
        });
        // Answer whatever is open, and run the paths a dropped or slow peer reaches.
        for stream in [1, 3, 5, 9] {
            conn.write_response(stream, 200, &[("x-a", "1")], Some(b"ok"), &mut out);
            conn.reset_stream(stream, 8, &mut out);
        }
        conn.expire_requests(std::time::Instant::now(), &mut out);
        conn.send_goaway(0, &mut out);
    });
    assert!(events > support::cases() / 20, "only {events} events");
}
