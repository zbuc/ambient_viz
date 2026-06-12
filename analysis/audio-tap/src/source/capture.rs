//! Live capture via cpal (`capture` feature).
//!
//! On the kiosk the device is the Daisy's UAC node — verified working
//! under PipeWire with pw-record (the historical "rate 0" capture fault
//! was Chromium-specific). cpal has no PipeWire host, so the node is
//! reached through the pipewire-alsa bridge: run with `--device pipewire`
//! (or `default`) and pin the node with
//! `PIPEWIRE_NODE=alsa_input.usb-ambient-viz_Daisy_audio_source_0001-00.analog-stereo`.
//! Direct `hw:` binding works when PipeWire releases the device;
//! pipewire-rs is the fallback if neither behaves (AUDIO_ANALYSIS_SIDECAR.md).

use std::sync::mpsc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{AudioBlock, AudioSource};

pub struct CaptureSource {
    rx: mpsc::Receiver<AudioBlock>,
    // Held for its Drop: the stream stops when the source is dropped.
    _stream: cpal::Stream,
    label: String,
}

impl CaptureSource {
    /// `device_name`: exact or substring match on the host's input
    /// devices; "default" picks the host default.
    pub fn open(device_name: &str) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = if device_name == "default" {
            host.default_input_device()
                .ok_or("no default input device")?
        } else {
            host.input_devices()
                .map_err(|e| e.to_string())?
                .find(|d| {
                    d.name()
                        .map(|n| n.contains(device_name))
                        .unwrap_or(false)
                })
                .ok_or_else(|| format!("no input device matching \"{device_name}\""))?
        };
        let label = device.name().unwrap_or_else(|_| "<unnamed>".into());
        let config = device
            .default_input_config()
            .map_err(|e| format!("{label}: {e}"))?;
        let channels = config.channels();
        let sample_rate = config.sample_rate().0;

        let (tx, rx) = mpsc::sync_channel::<AudioBlock>(64);
        let err_label = label.clone();
        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    // try_send: if the analysis loop stalls, drop blocks
                    // rather than back-pressure the audio callback.
                    let _ = tx.try_send(AudioBlock {
                        samples: data.to_vec(),
                        channels,
                        sample_rate,
                    });
                },
                move |e| eprintln!("audio-tap capture [{err_label}]: {e}"),
                None,
            )
            .map_err(|e| format!("{label}: {e}"))?;
        stream.play().map_err(|e| format!("{label}: {e}"))?;

        Ok(CaptureSource {
            rx,
            _stream: stream,
            label,
        })
    }
}

impl AudioSource for CaptureSource {
    fn next_block(&mut self) -> Option<AudioBlock> {
        // A capture source never "ends"; a long silence here means the
        // device died — surface it as end-of-source so main exits loudly.
        self.rx.recv_timeout(Duration::from_secs(5)).ok()
    }

    fn describe(&self) -> String {
        format!("capture:{}", self.label)
    }
}
