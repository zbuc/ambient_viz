//! Buffer-player substrate — the shared foundation for the buffer/grain
//! effects (`GRANULIZER.md`, `TRANSPORTER.md`); `freeze::Freeze` is the
//! degenerate case (one frozen grain looped). Three pieces:
//!
//! - [`CaptureBuffer`] — an interleaved ring of recent audio (live capture)
//!   *or* a held source, with a write head you can freeze and a
//!   linear-interpolated read at any fractional position (so grains can be
//!   pitched / reversed). On the embedded target this buffer belongs in
//!   SDRAM like the other FX buffers (the firmware allocator decides; this
//!   crate just `Vec`-allocates it once at construction, as `Freeze` does).
//! - [`WindowTable`] — a precomputed grain/crossfade envelope, indexed by
//!   normalized phase `0..=1`. The table pays the (transcendental) `cos`
//!   ONCE at construction; the hot path is a lookup + lerp. This is what
//!   keeps a cloud of grains cheap (per-sample `cos` × polyphony is the
//!   Cortex-M7 danger — mem `daisy-dsp-realtime`) AND lets the envelope be
//!   any shape, including the skewed attack/decay option, at the same cost.
//!   (`Freeze` instead uses an inline smootherstep polynomial for its single
//!   crossfade — fine for one fixed symmetric shape; the table wins when the
//!   shape varies or many grains share it.)
//! - [`Grain`] — one windowed playhead over a [`CaptureBuffer`]: a position
//!   advancing at `rate` (pitch; negative = reverse) for `len` output
//!   samples, amplitude-shaped by a [`WindowTable`]. The grain POOL +
//!   scheduler live in the granulizer; this is just the atom.
//!
//! `no_std`, allocation-free after construction, no per-sample
//! transcendentals.

use alloc::vec;
use alloc::vec::Vec;
use core::f32::consts::TAU;
use libm::cosf;

/// A precomputed envelope/crossfade curve, sampled on a fixed phase grid and
/// read by interpolation — so the per-sample cost is a lookup + lerp
/// regardless of how complex the shape is.
pub struct WindowTable {
    /// `size + 1` points covering phase `0..=1` inclusive, so the lerp's
    /// `i+1` index is always in bounds (no wrap, no branch).
    table: Vec<f32>,
    size: usize,
}

impl WindowTable {
    /// Sample an arbitrary `phase -> gain` shape (`phase` in `0..=1`) onto a
    /// `size`-segment table. Use for skewed grain envelopes, equal-power
    /// crossfades, etc. The closure runs `size + 1` times at construction.
    pub fn from_fn(size: usize, f: impl Fn(f32) -> f32) -> Self {
        let size = size.max(1);
        let mut table = vec![0.0; size + 1];
        for (i, t) in table.iter_mut().enumerate() {
            *t = f(i as f32 / size as f32);
        }
        Self { table, size }
    }

    /// A Hann (raised-cosine) grain window: `0` at both ends, `1` at the
    /// centre — fades each grain in from and out to silence, so grains carry
    /// no boundary click and overlap-add into a continuous texture. The only
    /// `cos` evaluations happen here, once.
    pub fn hann(size: usize) -> Self {
        Self::from_fn(size, |t| 0.5 * (1.0 - cosf(TAU * t)))
    }

    /// Interpolated lookup at `phase` (clamped to `0..=1`).
    #[inline]
    pub fn at(&self, phase: f32) -> f32 {
        let x = phase.clamp(0.0, 1.0) * self.size as f32;
        let i = x as usize; // floor; `phase<=1` so `i <= size`
        if i >= self.size {
            return self.table[self.size];
        }
        let frac = x - i as f32;
        let a = self.table[i];
        let b = self.table[i + 1];
        a + frac * (b - a)
    }
}

/// An interleaved ring of audio frames (`channels` samples per frame) —
/// either a live rolling capture (call [`write_frame`](Self::write_frame)
/// each frame) or a held source ([`freeze`](Self::freeze) the write head).
/// Reads are positional and fractional: [`read_lerp`](Self::read_lerp)
/// returns one channel at any frame position, wrapping the ring, which is
/// what lets a [`Grain`] play it pitched or reversed.
pub struct CaptureBuffer {
    buf: Vec<f32>, // channels * frames, interleaved
    frames: usize,
    channels: usize,
    /// Write head, in frames. Advances on `write_frame` unless frozen.
    write: usize,
    frozen: bool,
}

impl CaptureBuffer {
    pub fn new(frames: usize, channels: usize) -> Self {
        let frames = frames.max(1);
        let channels = channels.max(1);
        Self {
            buf: vec![0.0; frames * channels],
            frames,
            channels,
            write: 0,
            frozen: false,
        }
    }

    pub fn frames(&self) -> usize {
        self.frames
    }
    pub fn channels(&self) -> usize {
        self.channels
    }
    /// The frame index the next write lands on — the ring "seam" (newest /
    /// oldest boundary). Players read relative to this for "the last N".
    pub fn write_head(&self) -> usize {
        self.write
    }
    pub fn frozen(&self) -> bool {
        self.frozen
    }

    /// Stop/resume the write head. Frozen → the ring holds its contents and
    /// `write_frame` is a no-op, so a player grazes a held slice.
    pub fn freeze(&mut self, on: bool) {
        self.frozen = on;
    }

    /// Push one interleaved frame (`>= channels` samples read; extra
    /// ignored) and advance the write head. No-op while frozen.
    pub fn write_frame(&mut self, frame: &[f32]) {
        if self.frozen {
            return;
        }
        let base = self.write * self.channels;
        for c in 0..self.channels {
            self.buf[base + c] = frame.get(c).copied().unwrap_or(0.0);
        }
        self.write += 1;
        if self.write >= self.frames {
            self.write = 0;
        }
    }

    /// Linear-interpolated read of `channel` at fractional frame position
    /// `pos`, wrapping the ring (so a grain may run off either end). `pos`
    /// is in frames; precision is f32, ample for the modest ring sizes these
    /// effects use (a few seconds) — a long loaded source would keep its
    /// coarse position elsewhere and pass a reduced offset here.
    #[inline]
    pub fn read_lerp(&self, channel: usize, pos: f32) -> f32 {
        debug_assert!(channel < self.channels);
        let f = self.frames as f32;
        let mut p = pos % f;
        if p < 0.0 {
            p += f;
        }
        let i0 = p as usize % self.frames;
        let frac = p - (p as usize) as f32;
        let i1 = if i0 + 1 >= self.frames { 0 } else { i0 + 1 };
        let a = self.buf[i0 * self.channels + channel];
        let b = self.buf[i1 * self.channels + channel];
        a + frac * (b - a)
    }
}

/// One windowed playhead over a [`CaptureBuffer`]: reads from `pos`,
/// advancing `rate` frames per output sample (`1.0` = unity pitch, `2.0` =
/// up an octave, negative = reverse), for `len` output samples, its
/// amplitude shaped by a [`WindowTable`] across its life. The granulizer
/// owns a pool of these; the transporter uses whole-slice loops instead and
/// only shares the buffer + table.
#[derive(Clone, Copy)]
pub struct Grain {
    pos: f32,
    rate: f32,
    age: f32,
    len: f32,
    active: bool,
}

impl Grain {
    /// Start a grain at `start_pos` (frames into the buffer), playing at
    /// `rate` for `len_samples` output samples.
    pub fn start(start_pos: f32, rate: f32, len_samples: f32) -> Self {
        Self {
            pos: start_pos,
            rate,
            age: 0.0,
            len: len_samples.max(1.0),
            active: true,
        }
    }

    pub fn active(&self) -> bool {
        self.active
    }
    pub fn pos(&self) -> f32 {
        self.pos
    }
    /// Normalized life `0..=1` — the window-table phase.
    pub fn phase(&self) -> f32 {
        (self.age / self.len).min(1.0)
    }
    /// Current envelope gain (0 once finished).
    pub fn gain(&self, win: &WindowTable) -> f32 {
        if self.active { win.at(self.phase()) } else { 0.0 }
    }

    /// Advance one output sample; deactivates at end of life.
    pub fn advance(&mut self) {
        self.pos += self.rate;
        self.age += 1.0;
        if self.age >= self.len {
            self.active = false;
        }
    }

    /// Convenience: the windowed sample of `channel` at the current
    /// position, then advance. `None` once the grain is finished. (The
    /// granulizer can instead use `gain` + `pos` + `advance` directly to
    /// read multiple channels / pan a single read.)
    pub fn read(&mut self, buf: &CaptureBuffer, win: &WindowTable, channel: usize) -> Option<f32> {
        if !self.active {
            return None;
        }
        let s = buf.read_lerp(channel, self.pos) * win.at(self.phase());
        self.advance();
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── WindowTable ──────────────────────────────────────────────────────────

    #[test]
    fn hann_endpoints_and_peak() {
        let w = WindowTable::hann(2048);
        assert!(w.at(0.0).abs() < 1e-6, "hann(0) ~ 0");
        assert!((w.at(0.5) - 1.0).abs() < 1e-4, "hann(0.5) ~ 1");
        assert!(w.at(1.0).abs() < 1e-6, "hann(1) ~ 0");
    }

    #[test]
    fn hann_symmetric_and_rises_then_falls() {
        let w = WindowTable::hann(1024);
        for k in 0..=10 {
            let t = k as f32 / 20.0; // 0..0.5
            assert!((w.at(t) - w.at(1.0 - t)).abs() < 1e-4, "symmetry at {t}");
        }
        // monotone up on [0, 0.5]
        let mut prev = -1.0;
        for k in 0..=50 {
            let v = w.at(k as f32 / 100.0);
            assert!(v >= prev - 1e-4, "rising on first half");
            prev = v;
        }
    }

    #[test]
    fn at_clamps_out_of_range_and_interpolates() {
        let w = WindowTable::hann(1000);
        assert_eq!(w.at(-0.5), w.at(0.0));
        assert_eq!(w.at(1.5), w.at(1.0));
        // a point between grid nodes lands between its neighbours
        let mid = w.at(0.2503);
        let lo = w.at(0.250);
        let hi = w.at(0.251);
        assert!(mid >= lo.min(hi) - 1e-6 && mid <= lo.max(hi) + 1e-6);
    }

    #[test]
    fn from_fn_reproduces_an_arbitrary_shape() {
        // a skewed (sharp-attack/long-decay) envelope — the backlog option
        let w = WindowTable::from_fn(512, |t| if t < 0.1 { t / 0.1 } else { (1.0 - t) / 0.9 });
        // the corner falls between grid nodes, so the discrete peak is ~0.996,
        // not exactly 1 — that's correct table discretization, not error
        assert!((w.at(0.1) - 1.0).abs() < 1e-2, "peak near the attack corner");
        assert!(w.at(0.0).abs() < 1e-3);
        assert!(w.at(1.0).abs() < 1e-3);
        assert!(w.at(0.05) < w.at(0.1), "fast attack");
    }

    // ── CaptureBuffer ────────────────────────────────────────────────────────

    #[test]
    fn write_advances_and_wraps_freeze_holds() {
        let mut b = CaptureBuffer::new(4, 1);
        assert_eq!(b.write_head(), 0);
        for i in 0..4 {
            b.write_frame(&[i as f32]);
        }
        assert_eq!(b.write_head(), 0, "wrapped back to 0 after `frames` writes");
        // overwrite frame 0, then freeze and confirm writes stop
        b.write_frame(&[9.0]);
        assert_eq!(b.write_head(), 1);
        b.freeze(true);
        b.write_frame(&[99.0]);
        assert_eq!(b.write_head(), 1, "frozen: no advance");
        assert_eq!(b.read_lerp(0, 1.0), 1.0, "frozen: frame 1 untouched");
    }

    #[test]
    fn read_lerp_exact_then_interpolated_then_wraps() {
        let mut b = CaptureBuffer::new(4, 1);
        for v in [10.0, 20.0, 30.0, 40.0] {
            b.write_frame(&[v]);
        }
        assert_eq!(b.read_lerp(0, 0.0), 10.0);
        assert_eq!(b.read_lerp(0, 2.0), 30.0);
        assert!((b.read_lerp(0, 1.5) - 25.0).abs() < 1e-5, "halfway 20..30");
        // pos 3.5 interpolates frame 3 (40) -> wrapped frame 0 (10) = 25
        assert!((b.read_lerp(0, 3.5) - 25.0).abs() < 1e-5, "wrap seam interpolation");
        // negative / overshoot wrap
        assert_eq!(b.read_lerp(0, -1.0), b.read_lerp(0, 3.0));
        assert_eq!(b.read_lerp(0, 4.0), b.read_lerp(0, 0.0));
    }

    #[test]
    fn interleaved_channels_address_correctly() {
        let mut b = CaptureBuffer::new(3, 2);
        b.write_frame(&[1.0, -1.0]);
        b.write_frame(&[2.0, -2.0]);
        assert_eq!(b.read_lerp(0, 1.0), 2.0);
        assert_eq!(b.read_lerp(1, 1.0), -2.0);
        assert!((b.read_lerp(0, 0.5) - 1.5).abs() < 1e-5);
        assert!((b.read_lerp(1, 0.5) + 1.5).abs() < 1e-5);
    }

    // ── Grain ────────────────────────────────────────────────────────────────

    #[test]
    fn grain_lifecycle_and_window_shape() {
        let buf = {
            let mut b = CaptureBuffer::new(64, 1);
            for _ in 0..64 {
                b.write_frame(&[1.0]); // constant source -> output == window
            }
            b
        };
        let win = WindowTable::hann(2048);
        let mut g = Grain::start(0.0, 1.0, 32.0);
        assert!(g.active());
        let mut samples = vec![];
        while let Some(s) = g.read(&buf, &win, 0) {
            samples.push(s);
        }
        assert_eq!(samples.len(), 32, "grain plays exactly `len` samples");
        assert!(!g.active());
        assert!(samples[0].abs() < 0.05, "fades in from ~0");
        assert!(*samples.last().unwrap() < 0.2, "fades out toward 0");
        let mid = samples[16];
        assert!(mid > 0.9, "peaks near 1 at centre (constant source), got {mid}");
    }

    #[test]
    fn grain_rate_sets_pitch_and_reverse() {
        let mut b = CaptureBuffer::new(32, 1);
        for i in 0..32 {
            b.write_frame(&[i as f32]); // ramp, so position is readable from value
        }
        // forward, double rate: position advances 2 frames/sample
        let mut g = Grain::start(0.0, 2.0, 8.0);
        g.advance();
        assert!((g.pos() - 2.0).abs() < 1e-6);
        // reverse: negative rate walks backward, wrapping the ring
        let mut r = Grain::start(4.0, -1.0, 8.0);
        let s0 = r.read(&b, &WindowTable::from_fn(4, |_| 1.0), 0).unwrap(); // flat window
        assert!((s0 - 4.0).abs() < 1e-5, "reverse starts at pos 4 -> value 4");
        let s1 = r.read(&b, &WindowTable::from_fn(4, |_| 1.0), 0).unwrap();
        assert!((s1 - 3.0).abs() < 1e-5, "reverse steps back to value 3");
    }
}
