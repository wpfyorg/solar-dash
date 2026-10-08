//! The stick's clock is not real time: with no cloud to sync from it boots
//! from a fixed default and just counts seconds, so every record `ts` is
//! relative to that. Heartbeat frames (7e, device = type byte + clock>>8)
//! carry the stick's current clock at 256 s resolution; pairing each with
//! the moment it arrived brackets the stick-to-real skew, and the bracket
//! narrows each time the 256 s counter ticks over. Observed on the live
//! stick: the bracket ends up under a second.

#[derive(Debug, Clone, Copy)]
pub struct ClockSync {
    lo: f64,
    hi: f64,
    n: u32,
}

impl Default for ClockSync {
    fn default() -> Self {
        ClockSync { lo: f64::NEG_INFINITY, hi: f64::INFINITY, n: 0 }
    }
}

/// Heartbeat device bytes hold the clock only when they look like 2026-ish
/// time; other 7e frames carry sequence counters in the same bytes.
pub fn heartbeat_tail(device: [u8; 4]) -> Option<u32> {
    let tail = u32::from_be_bytes([0, device[1], device[2], device[3]]);
    ((0x68_0000..0x80_0000).contains(&tail) && matches!(device[0], 1 | 2 | 6)).then_some(tail)
}

impl ClockSync {
    /// `rx` is the real unix time the frame arrived, `tail` the clock>>8.
    pub fn observe(&mut self, rx: f64, tail: u32) {
        let base = rx - (tail as f64) * 256.0;
        // The stick clock is in [tail*256, tail*256+256), so skew is in (base-256, base].
        self.hi = self.hi.min(base);
        self.lo = self.lo.max(base - 256.0);
        self.n += 1;
    }

    /// Width of the bracket, seconds; infinite until the first observation.
    pub fn width(&self) -> f64 {
        if self.n == 0 {
            f64::INFINITY
        } else {
            (self.hi - self.lo).max(0.0)
        }
    }

    /// Best estimate of (real - stick) in seconds. If jitter made the bracket
    /// cross, fall back to its upper edge.
    pub fn skew(&self) -> Option<f64> {
        if self.n == 0 {
            None
        } else if self.hi >= self.lo {
            Some((self.hi + self.lo) / 2.0)
        } else {
            Some(self.hi)
        }
    }

    pub fn to_real(&self, stick_ts: u32) -> Option<u32> {
        self.skew().map(|s| (stick_ts as f64 + s).round().max(0.0) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converges_on_a_linear_clock() {
        let skew_true = 6_621_514.4_f64;
        let mut c = ClockSync::default();
        assert!(c.skew().is_none() && c.width().is_infinite());
        let mut rx = 1_791_446_117.0_f64;
        for i in 0..40 {
            let clock = rx - skew_true;
            c.observe(rx + 0.01, (clock / 256.0).floor() as u32);
            rx += 17.0 + (i % 5) as f64;
        }
        assert!(c.width() < 25.0, "width {}", c.width());
        assert!((c.skew().unwrap() - skew_true).abs() <= c.width());
        assert_eq!(c.to_real(1_784_824_603), Some((1_784_824_603.0 + c.skew().unwrap()).round() as u32));
    }

    #[test]
    fn heartbeat_detection() {
        assert_eq!(heartbeat_tail([0x06, 0x6a, 0x62, 0x43]), Some(0x6a6243));
        assert_eq!(heartbeat_tail([0x2a, 0x01, 0xb1, 0xd4]), None);
        assert_eq!(heartbeat_tail([0x37, 0x6a, 0x62, 0x43]), None);
    }
}
