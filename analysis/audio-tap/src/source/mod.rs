//! Audio sources — selected by cargo feature (`capture` / `file`),
//! chosen at runtime within whatever was compiled in. Both deliver
//! interleaved f32 blocks; the analysis loop downmixes to mono.

#[cfg(feature = "capture")]
pub mod capture;
#[cfg(feature = "file")]
pub mod file;

pub struct AudioBlock {
    pub samples: Vec<f32>, // interleaved
    pub channels: u16,
    #[allow(dead_code)] // part of the source contract; stage 1 sizes the RMS/FFT windows from it
    pub sample_rate: u32,
}

impl AudioBlock {
    /// Average channels into the caller's mono scratch buffer.
    pub fn downmix_into(&self, mono: &mut Vec<f32>) {
        mono.clear();
        let ch = self.channels.max(1) as usize;
        mono.reserve(self.samples.len() / ch);
        for frame in self.samples.chunks_exact(ch) {
            mono.push(frame.iter().sum::<f32>() / ch as f32);
        }
    }
}

pub trait AudioSource {
    /// Block until the next block of audio (None = source ended).
    fn next_block(&mut self) -> Option<AudioBlock>;
    fn describe(&self) -> String;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        let b = AudioBlock {
            samples: vec![1.0, 0.0, 0.5, 0.5],
            channels: 2,
            sample_rate: 48000,
        };
        let mut mono = Vec::new();
        b.downmix_into(&mut mono);
        assert_eq!(mono, vec![0.5, 0.5]);
    }
}
