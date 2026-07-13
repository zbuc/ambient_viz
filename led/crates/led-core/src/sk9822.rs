//! SK9822 / APA102 framing — the exact bitstream, and nothing else.
//!
//! The frame below drives BOTH parts correctly (cpldcpu, "SK9822 - a clone of the
//! APA102?", 2016):
//!
//! | section     | bytes         | contents                                       |
//! |-------------|---------------|------------------------------------------------|
//! | start frame | 4             | zeros                                          |
//! | LED frames  | 4 per LED     | `0xE0 \| global`, then **B, G, R**             |
//! | reset frame | 4             | zeros                                          |
//! | end frame   | >= n/2 bits   | zeros                                          |
//!
//! Two details here are the difference between working and subtly broken:
//!
//! * **The reset frame.** An SK9822 latches its PWM registers on the first cycle
//!   after the NEXT start frame, not immediately (an APA102 latches at once). Without
//!   these 4 zero bytes the strip displays each frame one frame late — which looks
//!   like mysterious lag, not like a bug. An APA102 ignores them.
//! * **The end frame is ZEROS, and its length scales with the strip.** Each LED
//!   delays the data by half a clock cycle, so the chain needs >= n/2 further clock
//!   edges to finish shifting. The datasheet says to send 32 bits of ONES; that is
//!   wrong twice over — it is too short above ~64 LEDs, and the ones shift into any
//!   LEDs you did not address and light them white.
//!
//! Byte order is B, G, R. Not RGB.

use crate::dim::Led;

/// Total bytes for a strip of `n` LEDs. Always a multiple of 4 — see [`Frame`].
pub const fn frame_len(n: usize) -> usize {
    4 + 4 * n + 4 + end_len(n)
}

/// End-frame bytes: >= n/2 bits => ceil(n/16) bytes, rounded up to a multiple of 4
/// so the whole frame stays 4-byte aligned.
pub const fn end_len(n: usize) -> usize {
    let bytes = n.div_ceil(16);
    (bytes + 3) & !3
}

/// Serialize a whole strip into `out`, returning the number of bytes written.
///
/// One buffer, one transfer. Do NOT emit a separate SPI write per LED: on a DMA
/// engine that becomes one transaction per pixel, and the per-burst setup cost
/// dominates the transfer itself.
pub fn encode(leds: &[Led], out: &mut [u8]) -> usize {
    let n = leds.len();
    let total = frame_len(n);
    assert!(out.len() >= total, "output buffer too small for {n} LEDs");

    out[..total].fill(0);

    let mut i = 4; // skip the start frame (already zeroed)
    for led in leds {
        out[i] = 0xE0 | (led.global & 0x1F);
        out[i + 1] = led.b;
        out[i + 2] = led.g;
        out[i + 3] = led.r;
        i += 4;
    }

    // The reset frame and the end frame are both zeros, and `fill(0)` above already
    // wrote them. They are load-bearing zeros, not padding.
    total
}

/// A 4-byte-aligned frame buffer.
///
/// The alignment is not cosmetic: esp-hal's ESP32 SPI DMA copies the entire buffer
/// before sending if it is not 4-byte aligned, silently turning a zero-copy transfer
/// into a memcpy of every frame.
#[repr(align(4))]
pub struct Frame<const BYTES: usize>(pub [u8; BYTES]);

impl<const BYTES: usize> Frame<BYTES> {
    pub const fn new() -> Self {
        Self([0; BYTES])
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.0
    }
}

impl<const BYTES: usize> Default for Frame<BYTES> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_length_matches_the_end_frame_rule() {
        // 4 start + 4n + 4 reset + ceil(n/16) rounded to 4.
        assert_eq!(frame_len(0), 8);
        assert_eq!(frame_len(1), 4 + 4 + 4 + 4);
        assert_eq!(frame_len(64), 4 + 256 + 4 + 4);
        assert_eq!(frame_len(144), 4 + 576 + 4 + 12); // ceil(144/16)=9 -> 12
        for n in 0..1000 {
            assert_eq!(
                frame_len(n) % 4,
                0,
                "frame must stay 4-byte aligned at n={n}"
            );
            // The end frame must supply at least n/2 clock cycles.
            assert!(end_len(n) * 8 >= n / 2, "end frame too short at n={n}");
        }
    }

    #[test]
    fn white_at_full_scale_is_all_ones() {
        let leds = [Led {
            global: 31,
            r: 255,
            g: 255,
            b: 255,
        }];
        let mut buf = [0u8; frame_len(1)];
        let n = encode(&leds, &mut buf);
        assert_eq!(n, buf.len());
        assert_eq!(&buf[4..8], &[0xFF, 0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn byte_order_is_bgr_not_rgb() {
        let leds = [Led {
            global: 1,
            r: 0xAA,
            g: 0xBB,
            b: 0xCC,
        }];
        let mut buf = [0u8; frame_len(1)];
        encode(&leds, &mut buf);
        assert_eq!(&buf[4..8], &[0xE1, 0xCC, 0xBB, 0xAA]);
    }

    #[test]
    fn start_reset_and_end_frames_are_zeros() {
        let leds = [Led {
            global: 31,
            r: 255,
            g: 255,
            b: 255,
        }; 40];
        let mut buf = [0u8; frame_len(40)];
        encode(&leds, &mut buf);

        assert_eq!(&buf[0..4], &[0, 0, 0, 0], "start frame");

        let reset = 4 + 4 * 40;
        assert_eq!(&buf[reset..reset + 4], &[0, 0, 0, 0], "SK9822 reset frame");

        // Every trailing byte is zero — a 0xFF end frame would light unaddressed LEDs.
        assert!(
            buf[reset + 4..].iter().all(|&b| b == 0),
            "end frame must be zeros"
        );
    }

    #[test]
    fn the_three_high_bits_are_always_set() {
        // They mark an LED frame, so a dark LED can never be mistaken for a start frame.
        let leds = [Led::OFF; 8];
        let mut buf = [0u8; frame_len(8)];
        encode(&leds, &mut buf);
        for i in 0..8 {
            assert_eq!(buf[4 + i * 4] & 0xE0, 0xE0);
        }
    }

    #[test]
    fn frame_buffer_is_4_byte_aligned() {
        let f: Frame<{ frame_len(144) }> = Frame::new();
        assert_eq!(f.as_slice().as_ptr() as usize % 4, 0);
    }
}
