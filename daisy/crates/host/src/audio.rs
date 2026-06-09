//! cpal output plumbing shared by the host binaries. Opens the default output
//! device and drives any [`Rig`] from the real-time callback.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use cpal::traits::{DeviceTrait as _, HostTrait as _};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

use crate::rigs::Rig;

/// The default output device plus the format details a [`Rig`] needs.
pub struct Output {
    pub device: cpal::Device,
    pub config: StreamConfig,
    pub sample_rate: f32,
    pub channels: usize,
    pub format: SampleFormat,
}

/// Open the system default output device.
pub fn open_default_output() -> Result<Output> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;
    let supported = device.default_output_config()?;
    let sample_rate = supported.sample_rate().0 as f32;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    Ok(Output { device, config, sample_rate, channels, format })
}

/// Build + return the output stream feeding `rig`. The stream is paused; call
/// `.play()` on it. Generic over the rig type so both a boxed `dyn Rig`
/// (sound_test) and a concrete rig (patch_server) work.
pub fn run_output<R>(out: &Output, rig: Arc<Mutex<R>>) -> Result<cpal::Stream>
where
    R: Rig + ?Sized + 'static,
{
    match out.format {
        SampleFormat::F32 => build_stream::<f32, R>(&out.device, &out.config, out.channels, rig),
        SampleFormat::I16 => build_stream::<i16, R>(&out.device, &out.config, out.channels, rig),
        SampleFormat::U16 => build_stream::<u16, R>(&out.device, &out.config, out.channels, rig),
        other => anyhow::bail!("unsupported sample format {other:?}"),
    }
}

fn build_stream<T, R>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    rig: Arc<Mutex<R>>,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
    R: Rig + ?Sized + 'static,
{
    let mut scratch: Vec<f32> = Vec::new();
    let stream = device.build_output_stream(
        config,
        move |output: &mut [T], _: &cpal::OutputCallbackInfo| {
            let frames = output.len() / channels;
            scratch.resize(frames * 2, 0.0);
            rig.lock().unwrap().render(&mut scratch);

            for (cpal_frame, dsp_frame) in
                output.chunks_exact_mut(channels).zip(scratch.chunks_exact(2))
            {
                let l = dsp_frame[0];
                let r = dsp_frame[1];
                if channels == 1 {
                    cpal_frame[0] = T::from_sample(0.5 * (l + r));
                } else {
                    cpal_frame[0] = T::from_sample(l);
                    cpal_frame[1] = T::from_sample(r);
                    for ch in &mut cpal_frame[2..] {
                        *ch = T::from_sample(0.0);
                    }
                }
            }
        },
        |err| eprintln!("stream error: {err}"),
        None,
    )?;
    Ok(stream)
}
