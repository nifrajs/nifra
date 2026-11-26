//! The `Date` response header (RFC 9110 section 6.6.1): an origin server with a clock sends it on
//! every response. The text is rebuilt at most once a second per thread.

use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const DAYS: [&[u8; 3]; 7] = [b"Thu", b"Fri", b"Sat", b"Sun", b"Mon", b"Tue", b"Wed"];
const MONTHS: [&[u8; 3]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];

/// `Sun, 06 Nov 1994 08:49:37 GMT` - always 29 bytes.
pub const IMF_LEN: usize = 29;

/// Format `secs` since the Unix epoch as an IMF-fixdate.
pub fn imf_fixdate(secs: u64) -> [u8; IMF_LEN] {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Civil-from-days (Hinnant), shifted so the year starts on 1 March.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    let mut out = [0u8; IMF_LEN];
    out[0..3].copy_from_slice(DAYS[(days % 7) as usize]);
    out[3..5].copy_from_slice(b", ");
    out[5] = b'0' + (day / 10) as u8;
    out[6] = b'0' + (day % 10) as u8;
    out[7] = b' ';
    out[8..11].copy_from_slice(MONTHS[(month - 1) as usize]);
    out[11] = b' ';
    let year = year as u64;
    out[12] = b'0' + (year / 1000 % 10) as u8;
    out[13] = b'0' + (year / 100 % 10) as u8;
    out[14] = b'0' + (year / 10 % 10) as u8;
    out[15] = b'0' + (year % 10) as u8;
    out[16] = b' ';
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    for (i, v) in [h, m, s].into_iter().enumerate() {
        out[17 + i * 3] = b'0' + (v / 10) as u8;
        out[18 + i * 3] = b'0' + (v % 10) as u8;
        if i < 2 {
            out[19 + i * 3] = b':';
        }
    }
    out[25] = b' ';
    out[26..29].copy_from_slice(b"GMT");
    out
}

thread_local! {
    static CACHE: Cell<(u64, [u8; IMF_LEN])> = const { Cell::new((u64::MAX, [0; IMF_LEN])) };
}

static CACHED_SECS: AtomicU64 = AtomicU64::new(u64::MAX);
static CLOCK_LEASES: Mutex<usize> = Mutex::new(0);

#[inline]
fn system_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// RAII lease allowing active event loops to supply cached wall-clock seconds without per-response
/// `clock_gettime` syscalls. Reverts to direct `SystemTime::now()` when the last lease drops.
pub struct ClockLeaseGuard(());

impl ClockLeaseGuard {
    pub fn new() -> Self {
        let mut leases = CLOCK_LEASES.lock().unwrap_or_else(|e| e.into_inner());
        if *leases == 0 {
            CACHED_SECS.store(system_now_secs(), Ordering::Relaxed);
        }
        *leases += 1;
        Self(())
    }
}

impl Default for ClockLeaseGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ClockLeaseGuard {
    fn drop(&mut self) {
        let mut leases = CLOCK_LEASES.lock().unwrap_or_else(|e| e.into_inner());
        *leases = leases.saturating_sub(1);
        if *leases == 0 {
            CACHED_SECS.store(u64::MAX, Ordering::Relaxed);
        }
    }
}

/// Update the loop-maintained cached Unix timestamp in seconds.
#[inline]
pub fn set_cached_secs(secs: u64) {
    CACHED_SECS.store(secs, Ordering::Relaxed);
}

/// Current Unix timestamp in seconds, using the loop-maintained cache when active.
#[inline]
pub fn now_secs() -> u64 {
    let cached = CACHED_SECS.load(Ordering::Relaxed);
    if cached != u64::MAX {
        cached
    } else {
        system_now_secs()
    }
}

/// Current `(unix_secs, imf_fixdate)` pair, rebuilt at most once a second per thread.
#[inline]
pub fn now_cached() -> (u64, [u8; IMF_LEN]) {
    let secs = now_secs();
    CACHE.with(|cache| {
        let (at, text) = cache.get();
        if at == secs {
            return (secs, text);
        }
        let text = imf_fixdate(secs);
        cache.set((secs, text));
        (secs, text)
    })
}

/// The current time as an IMF-fixdate, rebuilt when the second has changed.
pub fn now() -> [u8; IMF_LEN] {
    now_cached().1
}

/// Append `date: <now>\r\n`.
#[inline]
pub fn append_header(out: &mut Vec<u8>) {
    let text = now();
    out.extend_from_slice(b"date: ");
    out.extend_from_slice(&text);
    out.extend_from_slice(b"\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(&imf_fixdate(0), b"Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(&imf_fixdate(784_111_777), b"Sun, 06 Nov 1994 08:49:37 GMT");
        // Leap day, and the day after it.
        assert_eq!(
            &imf_fixdate(1_709_164_800),
            b"Thu, 29 Feb 2024 00:00:00 GMT"
        );
        assert_eq!(
            &imf_fixdate(1_709_251_199),
            b"Thu, 29 Feb 2024 23:59:59 GMT"
        );
        assert_eq!(
            &imf_fixdate(1_709_251_200),
            b"Fri, 01 Mar 2024 00:00:00 GMT"
        );
        // A year past 2100, which is not a leap year.
        assert_eq!(
            &imf_fixdate(4_107_542_400),
            b"Mon, 01 Mar 2100 00:00:00 GMT"
        );
    }

    #[test]
    fn now_is_a_well_formed_date() {
        let text = now();
        assert!(text.ends_with(b" GMT"));
        assert_eq!(text[3], b',');
    }
}
