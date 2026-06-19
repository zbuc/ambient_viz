//! Transporter — a reverse-grain **pad** generator built on the
//! [`buffer_player`](crate::buffer_player) substrate.
//!
//! The end goal is a smooth, polyphonic pad: a cloud of grains that **start
//! their read at the current playhead and play backward into the audio
//! prior to it** (negative rate) — each grain is sourced from points before
//! the playhead but plays in reverse *at* the playhead. Hann-windowed and
//! overlapping, they sum into a continuous, sustained wash — a reversed
//! ghost of the recent material. "Polyphonic" = the overlapping grain
//! cloud; "pad" = the smooth reversed texture; smoothness comes from the
//! window overlap.
//!
//! Increment 1 (this file): the **live-capture effect** form — input is
//! captured into the ring (the write head is the primary playhead), the
//! grain cloud trails it, and the pad is emitted as a **parallel send**
//! (input read-only, like [`freeze::Freeze`](crate::freeze)) for the engine
//! to mix under the dry. The grain-cloud core here is role-agnostic: a
//! played (MIDI, per-note pitched) instrument layer is the same scheduler
//! over a per-voice playhead + pitch, added later.
//!
//! `no_std`, allocation-free after construction, no per-sample
//! transcendentals (the only `cos` is in the window table's construction).

use alloc::vec::Vec;

use crate::buffer_player::{CaptureBuffer, Grain, WindowTable};

/// Capture ring length, seconds — must cover the largest `offset + grain`
/// of audio behind the playhead the cloud reads.
const BUF_SECONDS: f32 = 4.0;
/// Grain envelope table resolution.
const WIN_SIZE: usize = 2048;
/// Max simultaneous grains (the H750 polyphony cap). Average active grains
/// ≈ `density · grain_len_s`; keep that under this.
pub const MAX_GRAINS: usize = 48;

/// Reverse-grain pad. Owns its capture ring, window, and grain pool.
pub struct Transporter {
    buf: CaptureBuffer,
    win: WindowTable,
    grains: Vec<Grain>,
    sample_rate: f32,

    /// Grain length, samples.
    grain_len: f32,
    /// Grains spawned per second (drives overlap / polyphony).
    density: f32,
    /// Frames behind the playhead to *start* the reverse read. The grain
    /// then reads backward into the audio prior to that point (e.g. start at
    /// playhead−offset, then …−1, …−2). 0 would start at the playhead itself.
    offset: f32,
    /// Grain playback-rate magnitude (pitch; 1.0 = unity, 2.0 = +octave).
    pitch: f32,
    /// Reverse playback (the showcased pad behaviour). False = forward.
    reverse: bool,
    /// Spawn-start jitter, 0..1 (fraction of grain length) — scatters the
    /// cloud so overlapping grains decorrelate into a smooth pad rather than
    /// a comb.
    spread: f32,
    /// Pad output level.
    level: f32,

    /// Grain-scheduler accumulator (fractional grains owed).
    sched: f32,
    /// xorshift PRNG state for jitter (deterministic).
    rng: u32,
}

impl Transporter {
    pub fn new(sample_rate: f32) -> Self {
        let frames = (BUF_SECONDS * sample_rate).max(2.0) as usize;
        let mut grains = Vec::with_capacity(MAX_GRAINS);
        // Seed the pool with finished grains (inactive slots to reuse).
        for _ in 0..MAX_GRAINS {
            grains.push(Grain::start(0.0, 0.0, 1.0));
        }
        for g in &mut grains {
            while g.active() {
                g.advance();
            }
        }
        Self {
            buf: CaptureBuffer::new(frames, 2),
            win: WindowTable::hann(WIN_SIZE),
            grains,
            sample_rate,
            grain_len: 0.1 * sample_rate, // 100 ms
            density: 40.0,
            offset: 0.15 * sample_rate, // 150 ms behind: start the reverse read offset-back
            pitch: 1.0,
            reverse: true,
            spread: 0.3,
            level: 0.8,
            sched: 0.0,
            rng: 0x1234_5678,
        }
    }

    // ── params (seconds/ratios at the boundary; samples/frames inside) ──────
    pub fn set_grain_ms(&mut self, ms: f32) {
        self.grain_len = (ms * 0.001 * self.sample_rate).max(2.0);
    }
    pub fn set_density(&mut self, grains_per_s: f32) {
        self.density = grains_per_s.clamp(0.0, 400.0);
    }
    /// Optional pre-delay before the reverse read starts (0 = at the
    /// playhead, the default).
    pub fn set_offset_ms(&mut self, ms: f32) {
        self.offset = (ms * 0.001 * self.sample_rate).max(0.0);
    }
    pub fn set_pitch(&mut self, ratio: f32) {
        self.pitch = ratio.clamp(0.0, 8.0);
    }
    pub fn set_reverse(&mut self, on: bool) {
        self.reverse = on;
    }
    pub fn set_spread(&mut self, s: f32) {
        self.spread = s.clamp(0.0, 1.0);
    }
    pub fn set_level(&mut self, l: f32) {
        self.level = l.max(0.0);
    }

    /// Active grain count — for the inspector / polyphony tuning.
    pub fn active_grains(&self) -> usize {
        self.grains.iter().filter(|g| g.active()).count()
    }

    #[inline]
    fn next_rand(&mut self) -> f32 {
        // xorshift32 -> [0, 1)
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Spawn one grain starting at the playhead (`write_head − 1`, the just-
    /// written sample), minus the optional pre-delay and a length-scaled
    /// jitter, reading backward (reverse) or forward at `pitch`. Reuses a
    /// finished slot; if the pool is full, steals the grain nearest the end
    /// of its life (smoothest to drop).
    fn spawn(&mut self) {
        let jitter = self.spread * self.grain_len * (self.next_rand() - 0.5);
        let playhead = self.buf.write_head() as f32 - 1.0;
        let start = playhead - self.offset + jitter;
        let rate = if self.reverse { -self.pitch } else { self.pitch };
        let grain = Grain::start(start, rate, self.grain_len);

        if let Some(slot) = self.grains.iter_mut().find(|g| !g.active()) {
            *slot = grain;
            return;
        }
        // pool full: replace the grain furthest through its window (least
        // audible to cut — its envelope is already near zero)
        if let Some(slot) = self
            .grains
            .iter_mut()
            .max_by(|a, b| a.phase().partial_cmp(&b.phase()).unwrap())
        {
            *slot = grain;
        }
    }

    /// Capture `input` (stereo interleaved, read-only) and fill `pad` (same
    /// length) with the reverse-grain pad. Parallel send: the engine mixes
    /// `pad` under the dry.
    pub fn process(&mut self, input: &[f32], pad: &mut [f32]) {
        let per_sample = self.density / self.sample_rate;
        for (inp, out) in input.chunks_exact(2).zip(pad.chunks_exact_mut(2)) {
            // 1. advance the primary playhead by capturing the input
            self.buf.write_frame(inp);

            // 2. schedule new grains behind the (just-advanced) playhead
            self.sched += per_sample;
            while self.sched >= 1.0 {
                self.sched -= 1.0;
                self.spawn();
            }

            // 3. sum the active grain cloud (stereo), windowed
            let mut l = 0.0;
            let mut r = 0.0;
            for g in &mut self.grains {
                if !g.active() {
                    continue;
                }
                let env = g.gain(&self.win);
                let p = g.pos();
                l += self.buf.read_lerp(0, p) * env;
                r += self.buf.read_lerp(1, p) * env;
                g.advance();
            }
            out[0] = l * self.level;
            out[1] = r * self.level;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const SR: f32 = 48_000.0;

    /// Run the transporter over a constant DC input for `frames` frames,
    /// returning the pad output (after a warmup so grains are established).
    fn run_constant(t: &mut Transporter, value: f32, frames: usize) -> Vec<f32> {
        let input = vec![value; frames * 2];
        let mut pad = vec![0.0; frames * 2];
        t.process(&input, &mut pad);
        pad
    }

    #[test]
    fn grains_spawn_and_stay_under_the_cap() {
        let mut t = Transporter::new(SR);
        t.set_density(40.0);
        t.set_grain_ms(100.0); // avg ≈ 4 active grains
        run_constant(&mut t, 1.0, (SR as usize) / 4); // 0.25 s
        let n = t.active_grains();
        assert!(n > 0, "grains should be active");
        assert!(n <= MAX_GRAINS, "never exceeds the pool cap");
    }

    #[test]
    fn pad_is_smooth_and_sustained_from_constant_input() {
        let mut t = Transporter::new(SR);
        t.set_density(60.0);
        t.set_grain_ms(120.0); // overlap ≈ 7 → smooth sum
        t.set_level(1.0);
        // fill the ring + establish the cloud, then measure a later window
        run_constant(&mut t, 1.0, SR as usize); // 1 s warmup
        let pad = run_constant(&mut t, 1.0, SR as usize / 2);

        // sustained: well above silence across the window (left channel)
        let mut lo = f32::INFINITY;
        let mut max_jump = 0.0_f32;
        let start = 4000; // skip the block edge
        for i in (start + 1)..(pad.len() / 2) {
            let v = pad[2 * i];
            lo = lo.min(v);
            let d = (pad[2 * i] - pad[2 * (i - 1)]).abs();
            max_jump = max_jump.max(d);
        }
        assert!(lo > 0.1, "pad sustains above silence, min was {lo}");
        // smooth: no per-sample discontinuities (Hann grains over DC sum
        // continuously; a click would spike this)
        assert!(max_jump < 0.05, "pad should be click-free, max jump {max_jump}");
    }

    #[test]
    fn reverse_grain_starts_at_playhead_and_reads_backward() {
        // A reverse grain (default offset 0) starts at the playhead — the
        // just-written sample — and reads backward into the prior audio.
        let mut t = Transporter::new(SR);
        t.set_density(0.0); // no auto-spawn: spawn one by hand, deterministically
        t.set_offset_ms(0.0);
        t.set_spread(0.0);
        t.set_reverse(true);
        // advance the playhead with a ramp (value == frame index)
        let n = 1000;
        let mut input = vec![0.0; n * 2];
        for i in 0..n {
            input[2 * i] = i as f32;
            input[2 * i + 1] = i as f32;
        }
        let mut pad = vec![0.0; n * 2];
        t.process(&input, &mut pad);
        assert_eq!(t.active_grains(), 0, "density 0 spawns nothing");

        let playhead = t.buf.write_head() as f32 - 1.0; // last written = 999
        t.spawn();
        let g = *t.grains.iter().find(|g| g.active()).unwrap();
        assert!((g.pos() - playhead).abs() < 1.0, "starts at the playhead, got {}", g.pos());
        let p0 = g.pos();
        let mut g2 = g;
        g2.advance();
        assert!(g2.pos() < p0, "reverse grain reads backward into prior audio");
    }

    #[test]
    fn forward_mode_steps_forward() {
        let mut t = Transporter::new(SR);
        t.set_density(0.0);
        t.set_reverse(false);
        t.set_spread(0.0);
        run_constant(&mut t, 0.5, 1000);
        t.spawn();
        let g = *t.grains.iter().find(|g| g.active()).unwrap();
        let mut g2 = g;
        g2.advance();
        assert!(g2.pos() > g.pos(), "forward grain steps forward");
    }

    #[test]
    fn silent_input_gives_silent_pad() {
        let mut t = Transporter::new(SR);
        let pad = run_constant(&mut t, 0.0, SR as usize / 4);
        assert!(pad.iter().all(|&x| x.abs() < 1e-6), "DC-zero in -> silent pad");
    }
}
