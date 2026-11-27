//! Native HTTP response compression (`zstd`, `br`, `gzip`, `deflate`) with Accept-Encoding negotiation
//! and compressible media-type filtering.

use std::io::Write;

use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionEncoding {
    Zstd,
    Brotli,
    Gzip,
    Deflate,
}

impl CompressionEncoding {
    #[inline]
    pub const fn header_value(self) -> &'static str {
        match self {
            Self::Zstd => "zstd",
            Self::Brotli => "br",
            Self::Gzip => "gzip",
            Self::Deflate => "deflate",
        }
    }
}

/// Select the best supported encoding from an `Accept-Encoding` header value (`zstd`/`br` > `gzip` > `deflate`).
pub fn negotiate_encoding(
    accept_encoding: Option<&str>,
    allow_br: bool,
    allow_gzip: bool,
    allow_deflate: bool,
    allow_zstd: bool,
) -> Option<CompressionEncoding> {
    let raw = accept_encoding?;
    let mut q_zstd = -1.0f32;
    let mut q_br = -1.0f32;
    let mut q_gzip = -1.0f32;
    let mut q_deflate = -1.0f32;
    let mut q_star = -1.0f32;

    for item in raw.split(',') {
        let mut parts = item.split(';').map(str::trim);
        let Some(token) = parts.next() else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        let mut q = 1.0f32;
        let mut valid = true;
        for param in parts {
            if let Some((k, v)) = param.split_once('=') {
                if k.trim().eq_ignore_ascii_case("q") {
                    if let Ok(parsed) = v.trim().parse::<f32>() {
                        if (0.0..=1.0).contains(&parsed) {
                            q = parsed;
                        } else {
                            valid = false;
                            break;
                        }
                    } else {
                        valid = false;
                        break;
                    }
                }
            }
        }
        if !valid {
            continue;
        }
        if token.eq_ignore_ascii_case("zstd") {
            q_zstd = q_zstd.max(q);
        } else if token.eq_ignore_ascii_case("br") {
            q_br = q_br.max(q);
        } else if token.eq_ignore_ascii_case("gzip") || token.eq_ignore_ascii_case("x-gzip") {
            q_gzip = q_gzip.max(q);
        } else if token.eq_ignore_ascii_case("deflate") {
            q_deflate = q_deflate.max(q);
        } else if token == "*" {
            q_star = q_star.max(q);
        }
    }

    let eff = |specific: f32, allowed: bool| -> f32 {
        if !allowed {
            return 0.0;
        }
        if specific >= 0.0 {
            specific
        } else if q_star >= 0.0 {
            q_star
        } else {
            0.0
        }
    };

    let candidates = [
        (CompressionEncoding::Brotli, eff(q_br, allow_br)),
        (CompressionEncoding::Zstd, eff(q_zstd, allow_zstd)),
        (CompressionEncoding::Gzip, eff(q_gzip, allow_gzip)),
        (CompressionEncoding::Deflate, eff(q_deflate, allow_deflate)),
    ];

    let mut best: Option<(CompressionEncoding, f32)> = None;
    for (enc, q) in candidates {
        if q <= 0.0 {
            continue;
        }
        if best.is_none_or(|(_, best_q)| q > best_q) {
            best = Some((enc, q));
        }
    }
    best.map(|(enc, _)| enc)
}

/// Whether `content_type` represents payload data worth compressing (skips pre-compressed media).
pub fn is_compressible_content_type(content_type: Option<&str>) -> bool {
    let Some(raw) = content_type else {
        return true;
    };
    let essence = raw
        .split_once(';')
        .map_or(raw, |(left, _)| left)
        .trim()
        .to_ascii_lowercase();
    if essence.is_empty() {
        return true;
    }
    if essence.starts_with("text/") {
        return true;
    }
    if essence.ends_with("+json") || essence.ends_with("+xml") {
        return true;
    }
    matches!(
        essence.as_str(),
        "application/json"
            | "application/javascript"
            | "application/ecmascript"
            | "application/xml"
            | "application/xhtml+xml"
            | "application/wasm"
            | "application/x-www-form-urlencoded"
            | "image/svg+xml"
    )
}

/// Compress `input` with `enc` and return the compressed buffer only when strictly smaller than `input`.
pub fn compress_bytes(enc: CompressionEncoding, input: &[u8]) -> Option<Vec<u8>> {
    if input.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() / 2 + 32);
    match enc {
        CompressionEncoding::Zstd => {
            out = zstd::bulk::compress(input, 3).ok()?;
        }
        CompressionEncoding::Brotli => {
            let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 4, 22);
            writer.write_all(input).ok()?;
            writer.flush().ok()?;
            drop(writer);
        }
        CompressionEncoding::Gzip => {
            let mut encoder = GzEncoder::new(out, Compression::fast());
            encoder.write_all(input).ok()?;
            out = encoder.finish().ok()?;
        }
        CompressionEncoding::Deflate => {
            let mut encoder = ZlibEncoder::new(out, Compression::fast());
            encoder.write_all(input).ok()?;
            out = encoder.finish().ok()?;
        }
    }
    (out.len() < input.len()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_quality_and_priority() {
        assert_eq!(
            negotiate_encoding(Some("gzip, deflate, br"), true, true, true, true),
            Some(CompressionEncoding::Brotli)
        );
        assert_eq!(
            negotiate_encoding(Some("zstd;q=1.0, br;q=0.8"), true, true, true, true),
            Some(CompressionEncoding::Zstd)
        );
        assert_eq!(
            negotiate_encoding(Some("gzip;q=1.0, br;q=0.5"), true, true, true, true),
            Some(CompressionEncoding::Gzip)
        );
        assert_eq!(
            negotiate_encoding(Some("br;q=0, gzip;q=0.8"), true, true, true, true),
            Some(CompressionEncoding::Gzip)
        );
        assert_eq!(
            negotiate_encoding(Some("identity"), true, true, true, true),
            None
        );
    }

    #[test]
    fn skips_incompressible_types_and_incompressible_data() {
        assert!(is_compressible_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(is_compressible_content_type(Some("image/svg+xml")));
        assert!(!is_compressible_content_type(Some("image/png")));
        assert!(!is_compressible_content_type(Some("video/mp4")));

        let repetitive = b"hello world ".repeat(128);
        let brotli = compress_bytes(CompressionEncoding::Brotli, &repetitive).unwrap();
        let mut br_out = Vec::new();
        std::io::copy(
            &mut brotli::Decompressor::new(brotli.as_slice(), 4096),
            &mut br_out,
        )
        .unwrap();
        assert_eq!(br_out, repetitive);

        let gzip = compress_bytes(CompressionEncoding::Gzip, &repetitive).unwrap();
        let mut gz_out = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::GzDecoder::new(gzip.as_slice()),
            &mut gz_out,
        )
        .unwrap();
        assert_eq!(gz_out, repetitive);

        let deflate = compress_bytes(CompressionEncoding::Deflate, &repetitive).unwrap();
        let mut df_out = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::ZlibDecoder::new(deflate.as_slice()),
            &mut df_out,
        )
        .unwrap();
        assert_eq!(df_out, repetitive);

        let zstd_bytes = compress_bytes(CompressionEncoding::Zstd, &repetitive).unwrap();
        let zstd_out = zstd::bulk::decompress(&zstd_bytes, repetitive.len() * 2).unwrap();
        assert_eq!(zstd_out, repetitive);

        assert!(compress_bytes(CompressionEncoding::Brotli, b"hi").is_none());
    }
}
