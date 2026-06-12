//! File decode via symphonia (`file` feature) — the deterministic mode:
//! fixture mp3 in, reproducible analysis out, which is what the offline
//! gate drives.
//!
//! v0 scaffold PACES decode at real time (sleep per block duration) so
//! the published stream has live cadence. The clock-slave wiring — seek/
//! pace against `clock.daisy.{position,rate}` consumed over /bus/events
//! through the SongClock port (src/songclock.rs) — is stage-1 work: it
//! needs the SSE reader, and seeking symphonia by time. The SongClock
//! itself is already here and tested.

use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use super::{AudioBlock, AudioSource};

pub struct FileSource {
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    label: String,
    started: Option<Instant>,
    samples_emitted: u64,
    sample_rate: u32,
    channels: u16,
}

impl FileSource {
    pub fn open(path: &Path) -> Result<Self, String> {
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
        })
    }
}

impl AudioSource for FileSource {
    fn next_block(&mut self) -> Option<AudioBlock> {
        loop {
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

            // Real-time pacing: sleep until this block's position.
            let started = *self.started.get_or_insert_with(Instant::now);
            let due = Duration::from_secs_f64(
                self.samples_emitted as f64 / self.sample_rate as f64,
            );
            let elapsed = started.elapsed();
            if due > elapsed {
                std::thread::sleep(due - elapsed);
            }
            self.samples_emitted += (buf.samples().len() / self.channels as usize) as u64;

            return Some(AudioBlock {
                samples: buf.samples().to_vec(),
                channels: self.channels,
                sample_rate: self.sample_rate,
            });
        }
    }

    fn describe(&self) -> String {
        format!("file:{}", self.label)
    }
}
