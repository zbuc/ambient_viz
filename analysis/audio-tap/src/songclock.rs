//! SongClock — the consumer half of the clock contract (migration phase
//! 7), third implementation. Port of static/song-clock.js; the JS file's
//! header is the spec. Semantics, restated:
//!
//!   - ANCHOR on every position report (t0 = local receipt time); a
//!     backward anchor IS the loop-wrap hard snap.
//!   - RATE updates change the slope from the next now() on; non-finite
//!     or implausible rates (<0, >4) never become a slope.
//!   - STALE: past stale_ms with no anchor, the clock FREEZES at the
//!     stale-boundary value — it holds still, it never steps backward.
//!
//! The `file` source slaves decode position to this clock so the sidecar
//! analyzes the same timeline the room hears.

pub const NOMINAL_RATE: f64 = 1.0;

pub struct SongClock {
    pos0: Option<f64>,
    t0: f64,
    rate: f64,
    stale_ms: f64,
}

impl SongClock {
    pub fn new(stale_ms: f64) -> Self {
        SongClock {
            pos0: None,
            t0: 0.0,
            rate: NOMINAL_RATE,
            stale_ms,
        }
    }

    pub fn on_position(&mut self, pos: f64, at_ms: f64) {
        if !pos.is_finite() || !at_ms.is_finite() {
            return;
        }
        self.pos0 = Some(pos);
        self.t0 = at_ms;
    }

    pub fn on_rate(&mut self, r: f64) {
        if !r.is_finite() || !(0.0..=4.0).contains(&r) {
            return;
        }
        self.rate = r;
    }

    /// Extrapolated position (seconds), or None before the first anchor.
    pub fn now(&self, at_ms: f64) -> Option<f64> {
        let pos0 = self.pos0?;
        let age = (at_ms - self.t0).max(0.0);
        Some(pos0 + self.rate * age.min(self.stale_ms) / 1000.0)
    }

    pub fn stale(&self, at_ms: f64) -> bool {
        self.pos0.is_some() && at_ms - self.t0 > self.stale_ms
    }
}

impl Default for SongClock {
    fn default() -> Self {
        SongClock::new(2000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrapolates_from_anchor_at_rate() {
        let mut c = SongClock::default();
        assert_eq!(c.now(0.0), None);
        c.on_position(10.0, 1000.0);
        assert_eq!(c.now(1000.0), Some(10.0));
        assert_eq!(c.now(1500.0), Some(10.5));
        c.on_rate(1.01);
        assert_eq!(c.now(2000.0), Some(10.0 + 1.01));
    }

    #[test]
    fn implausible_rates_never_become_a_slope() {
        let mut c = SongClock::default();
        c.on_position(0.0, 0.0);
        for bad in [f64::NAN, f64::INFINITY, -0.1, 4.1] {
            c.on_rate(bad);
        }
        assert_eq!(c.now(1000.0), Some(1.0)); // still nominal 1.0
    }

    #[test]
    fn backward_anchor_is_the_wrap_snap() {
        let mut c = SongClock::default();
        c.on_position(1080.0, 1000.0); // near the loop end
        c.on_position(0.5, 1050.0); // RESET: hard snap backward
        assert_eq!(c.now(1050.0), Some(0.5));
    }

    #[test]
    fn freezes_at_stale_boundary_never_rewinds() {
        let mut c = SongClock::new(2000.0);
        c.on_position(10.0, 0.0);
        assert_eq!(c.now(2000.0), Some(12.0));
        assert_eq!(c.now(10_000.0), Some(12.0)); // frozen, not rewound
        assert!(c.stale(10_000.0));
        assert!(!c.stale(1999.0));
    }
}
