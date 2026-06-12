//! File decode via symphonia (`file` feature) — the deterministic mode
//! and, slaved to the bus clock, the exhibit mode: decode position
//! follows `clock.daisy.position` so the sidecar analyzes the same
//! timeline the room hears (the job the page's localaudio mp3-sync hack
//! used to do).
//!
//! Pacing:
//!   - SLAVED (a ClockFeed is attached and anchored): wait until the
//!     clock reaches each block's position; drift beyond SYNC_THRESH_S
//!     (wrap/RESET, bridge restart) is corrected by a coarse seek —
//!     LOCAL_AUDIO semantics. A stale clock freezes; we fall back to
//!     approximate wall pacing until anchors return.
//!   - FREE-RUN (no clock): real-time pacing against the wall clock.

use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use crate::clockfeed::ClockFeed;

use super::{AudioBlock, AudioSource};

/// Re-seek when decode position and the clock disagree by more than this
/// (the page's localaudio re-sync posture; loop wraps land here).
const SYNC_THRESH_S: f64 = 0.75;
/// How tightly the slaved pacing follows the clock.
const PACE_SLACK_S: f64 = 0.05;

pub struct FileSource {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    label: String,
    started: Option<Instant>,
    samples_emitted: u64,
    sample_rate: u32,
    channels: u16,
    clock: Option<Arc<ClockFeed>>,
}

impl FileSource {
    pub fn open(path: &Path, clock: Option<Arc<ClockFeed>>) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let format = probed.format;
        let track = format
            .default_track()
            .ok_or("no default audio track")?;
        let track_id = track.id;
        let params = &track.codec_params;
        let sample_rate = params.sample_rate.ok_or("unknown sample rate")?;
        let channels = params
            .channels
            .map(|c| c.count() as u16)
            .ok_or("unknown channel count")?;
        let decoder = symphonia::default::get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(|e| e.to_string())?;
        Ok(FileSource {
            format,
            decoder,
            track_id,
            label: path.display().to_string(),
            started: None,
            samples_emitted: 0,
            sample_rate,
            channels,
            clock,
        })
    }

    fn position_s(&self) -> f64 {
        self.samples_emitted as f64 / self.sample_rate as f64
    }

    fn seek_to(&mut self, target_s: f64) {
        let target_s = target_s.max(0.0);
        let to = SeekTo::Time {
            time: Time::new(target_s as u64, target_s.fract()),
            track_id: Some(self.track_id),
        };
        // ACCURATE, not Coarse: the piece is a VBR mp3, and a coarse
        // (byte-estimate) seek landed ~5 s away from its reported
        // actual_ts in the first dual-writer soak — a constant content
        // offset the slave then trusts forever. Accurate seeking scans,
        // which costs real time only at session start and loop wraps.
        match self.format.seek(SeekMode::Accurate, to) {
            Ok(seeked) => {
                self.decoder.reset();
                let tb = self
                    .format
                    .tracks()
                    .iter()
                    .find(|t| t.id == self.track_id)
                    .and_then(|t| t.codec_params.time_base);
                let landed_s = tb
                    .map(|tb| {
                        let t = tb.calc_time(seeked.actual_ts);
                        t.seconds as f64 + t.frac
                    })
                    .unwrap_or(target_s);
                self.samples_emitted = (landed_s * self.sample_rate as f64) as u64;
                eprintln!(
                    "audio-tap: clock re-sync -> {:.2}s (landed {:.2}s)",
                    target_s, landed_s
                );
            }
            Err(e) => eprintln!("audio-tap: seek to {target_s:.2}s failed: {e}"),
        }
    }

    /// Slaved pacing + drift correction; returns after the clock permits
    /// emitting the block that STARTS at the current decode position.
    fn pace(&mut self) {
        let pos = self.position_s();
        if let Some(cf) = self.clock.clone() {
            if let Some(target) = cf.position() {
                let drift = pos - target;
                if drift.abs() > SYNC_THRESH_S {
                    self.seek_to(target);
                    return;
                }
                if !cf.stale() {
                    // ahead of the room: wait for the clock (behind: emit
                    // immediately — decoding outruns real time and catches up)
                    while !cf.stale() {
                        match cf.position() {
                            Some(t) if t >= pos - PACE_SLACK_S => break,
                            Some(_) => std::thread::sleep(Duration::from_millis(5)),
                            None => break,
                        }
                    }
                    return;
                }
            }
            // no anchor yet, or stale: approximate wall pacing below
        }
        let started = *self.started.get_or_insert_with(Instant::now);
        let due = Duration::from_secs_f64(pos);
        let elapsed = started.elapsed();
        if due > elapsed {
            std::thread::sleep(due - elapsed);
        }
    }
}

impl AudioSource for FileSource {
    fn next_block(&mut self) -> Option<AudioBlock> {
        loop {
            self.pace();
            let packet = self.format.next_packet().ok()?; // EOF -> None
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(_) => continue, // skip a bad frame, keep the stream
            };
            let mut buf =
                SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
            buf.copy_interleaved_ref(decoded);
            self.samples_emitted += (buf.samples().len() / self.channels as usize) as u64;
            return Some(AudioBlock {
                samples: buf.samples().to_vec(),
                channels: self.channels,
                sample_rate: self.sample_rate,
            });
        }
    }

    fn describe(&self) -> String {
        let mode = if self.clock.is_some() { "clock-slaved" } else { "free-run" };
        format!("file:{} ({mode})", self.label)
    }
}
