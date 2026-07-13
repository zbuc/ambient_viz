//! node-fw — the thin chip layer: SPI+DMA out, (later) ESP-NOW in.
//!
//! !!! UNVERIFIED: this has never been compiled. !!!
//!
//! There is no esp toolchain on this machine, so every `esp_hal::` call below is
//! written against the documented 1.1 API but has NOT been checked by a compiler.
//! Expect to fix names on the first build — particularly the DMA binding, which is
//! the API esp-hal is actively churning (SpiDmaBus is being merged into SpiDma for
//! 1.2). The logic that matters does not live here; it lives in `led-core`, which
//! IS tested. Keep it that way: if you find yourself writing color or timing code
//! in this file, it belongs one crate over.
//!
//! Step 1 (this file): light the strip, judge the fade by eye against `led-sim`.
//! Step 2: esp-radio ESP-NOW receive -> control signals -> render own slice.
//! Step 3: OTA (esp-bootloader-esp-idf), because six nodes on a wall must not need
//!         a USB cable each.
//!
//! Wiring (ESP32-DevKitC-32, VSPI):
//!   GPIO18 -> SCLK ─┐
//!   GPIO23 -> MOSI ─┴─> 74AHCT125 level shifter (3.3V -> 5V) -> strip CI / DI
//!   GND    -> strip GND  (COMMON GROUND with the strip's own 5V supply)
//!   Do NOT power the strip from the dev board's 5V pin: it is USB-limited, and a
//!   sagging rail dims blue/green before red, so a browning-out strip goes muddy
//!   orange at the far end rather than simply dimming.

#![no_std]
#![no_main]

use esp_backtrace as _;
use esp_hal::clock::CpuClock;
use esp_hal::delay::Delay;
use esp_hal::dma_tx_buffer;
use esp_hal::main;
use esp_hal::spi::master::{Config as SpiConfig, Spi};
use esp_hal::spi::Mode;
use esp_hal::time::Rate;

use led_core::color::Gamma;
use led_core::dim::Dimmer;
use led_core::{sk9822, Led, Rgb16};

/// LEDs on this node's strip.
const STRIP: usize = 144;
/// Wire bytes for one frame — start + LED frames + SK9822 reset + end frame.
const FRAME_BYTES: usize = sk9822::frame_len(STRIP);

/// 8 MHz is deliberately conservative. The part will take far more, but clock/data
/// skew over a few metres of strip is the limit, not the silicon. At 8 MHz a
/// 144-LED frame is ~0.6 ms, so even 200 fps costs ~12% of the wire.
const SPI_HZ: u32 = 8_000_000;

#[main]
fn main() -> ! {
    let peripherals = esp_hal::init(esp_hal::Config::default().with_cpu_clock(CpuClock::max()));
    let delay = Delay::new();

    // VERIFY on first build: DMA channel binding + builder names. On ESP32 the SPI2
    // DMA channel is a peripheral singleton; in some esp-hal versions it is reached
    // through a `Dma::new(peripherals.DMA)` split instead.
    let (_, _, tx_buf, tx_desc) = dma_tx_buffer!(FRAME_BYTES);

    let mut spi = Spi::new(
        peripherals.SPI2,
        SpiConfig::default()
            .with_frequency(Rate::from_hz(SPI_HZ))
            .with_mode(Mode::_0),
    )
    .expect("spi init")
    .with_sck(peripherals.GPIO18)
    .with_mosi(peripherals.GPIO23)
    .with_dma(peripherals.DMA_SPI2)
    .with_buffers(tx_desc, tx_buf);

    let gamma = Gamma::G22;
    let mut dimmer: Dimmer<STRIP> = Dimmer::new(true);

    let mut px = [Rgb16::BLACK; STRIP];
    let mut leds = [Led::OFF; STRIP];
    // 4-byte aligned, so esp-hal DMAs it in place instead of copying it every frame.
    let mut frame: sk9822::Frame<FRAME_BYTES> = sk9822::Frame::new();

    // A slow breath, purely to prove the wire. The real thing renders its slice from
    // control signals — see PROJECT.md.
    let mut phase: u32 = 0;

    loop {
        phase = phase.wrapping_add(1);

        // Triangle 0..65535..0 over ~20 s at 60 fps: a fade slow enough that any
        // banding is obvious. This is the bench test for the whole dimming story.
        let t = (phase % 1200) as u32;
        let level = if t < 600 { t * 65535 / 600 } else { (1200 - t) * 65535 / 600 } as u16;

        for (i, p) in px.iter_mut().enumerate() {
            // A faint positional tint so the strip is not one flat colour.
            let warm = level.saturating_sub((i as u16).saturating_mul(64));
            *p = Rgb16 {
                r: gamma.map_u16(level),
                g: gamma.map_u16(warm / 3),
                b: gamma.map_u16(warm / 10),
            };
        }

        dimmer.map(&px, &mut leds);
        sk9822::encode(&leds, frame.as_mut_slice());

        // One buffer, one transfer. A write-per-LED here would be one DMA transaction
        // per pixel and the setup cost would dwarf the payload.
        spi.write(frame.as_slice()).expect("spi write");

        delay.delay_millis(16);
    }
}
