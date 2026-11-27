//! Seeded mutation fuzzing with no dependencies: every run is reproducible from the case number.
//! `NIFRA_FUZZ_CASES` raises the count for a long local or scheduled run.

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound.max(1) as u64) as usize
    }
}

pub fn cases() -> u64 {
    std::env::var("NIFRA_FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000)
}

/// Splices pieces of valid input together, then damages the result.
pub fn mutate(rng: &mut Rng, pieces: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for _ in 0..1 + rng.below(6) {
        out.extend_from_slice(&pieces[rng.below(pieces.len())]);
    }
    for _ in 0..rng.below(8) {
        if out.is_empty() {
            break;
        }
        let at = rng.below(out.len());
        match rng.below(7) {
            0 => out[at] ^= 1 << rng.below(8),
            1 => out[at] = [0, 1, 0x7f, 0x80, 0xff, b'\r', b'\n', b':'][rng.below(8)],
            2 => out.insert(at, rng.next() as u8),
            3 => {
                out.remove(at);
            }
            4 => out.truncate(at),
            5 => {
                let end = at + rng.below(out.len() - at);
                let copy = out[at..end].to_vec();
                out.splice(at..at, copy);
            }
            _ => {
                let extra = pieces[rng.below(pieces.len())].clone();
                out.splice(at..at, extra);
            }
        }
        out.truncate(64 * 1024);
    }
    out
}

/// Delivers `input` in random fragments to `feed`, which returns the bytes it consumed and whether
/// to go on, keeping the unconsumed tail as a transport does.
pub fn deliver(rng: &mut Rng, input: &[u8], mut feed: impl FnMut(&[u8]) -> (usize, bool)) {
    let mut buffer = Vec::new();
    let mut at = 0;
    while at < input.len() {
        let most = 1 + rng.below(512);
        let take = 1 + rng.below((input.len() - at).min(most));
        buffer.extend_from_slice(&input[at..at + take]);
        at += take;
        loop {
            let (consumed, open) = feed(&buffer);
            assert!(consumed <= buffer.len(), "consumed more than it was given");
            buffer.drain(..consumed);
            if !open {
                return;
            }
            if consumed == 0 || buffer.is_empty() {
                break;
            }
        }
    }
}

/// Runs every case, naming the one that panicked so it can be replayed.
pub fn run(mut case: impl FnMut(&mut Rng)) {
    // Replays exactly: the case number is the seed.
    for number in 0..cases() {
        let mut rng = Rng::new(number + 1);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| case(&mut rng)));
        assert!(result.is_ok(), "fuzz case {number} panicked");
    }
}
