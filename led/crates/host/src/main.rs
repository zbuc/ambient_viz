//! led-sim — judge fade quality without a strip attached.
//!
//! The question this answers: does a slow fade to black stay smooth, or does it
//! stair-step? That is the whole reason the SK9822 was chosen over an SK6812, and
//! it is cheaper to settle here than on a wall.
//!
//! Usage:
//!   cargo run -p led-host --bin led-sim              # all sections
//!   cargo run -p led-host --bin led-sim -- fade      # the dimming table
//!   cargo run -p led-host --bin led-sim -- dither    # dither convergence
//!   cargo run -p led-host --bin led-sim -- frame     # a wire-level frame dump

use led_core::color::Gamma;
use led_core::dim::{Dimmer, GLOBAL_MAX, PWM_MAX};
use led_core::sk9822;
use led_core::Rgb16;

const STRIP: usize = 144;

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match which.as_str() {
        "fade" => fade_table(),
        "dither" => dither_convergence(),
        "frame" => frame_dump(),
        _ => {
            fade_table();
            println!();
            dither_convergence();
            println!();
            frame_dump();
        }
    }
}

/// Walk a perceptual fade down to black and show what actually reaches the LED.
fn fade_table() {
    println!("== fade: perceptual input -> linear -> (global, pwm) -> effective ==");
    println!("PWM-only would be stuck at global=31, i.e. the 'pwm31' column.\n");
    println!(
        "{:>8}  {:>8}  {:>6} {:>5}  {:>10}  {:>10}  {:>8}",
        "input", "linear", "global", "pwm", "effective", "ideal", "pwm-only"
    );

    let g = Gamma::G22;
    let mut d: Dimmer<1> = Dimmer::new(false);

    for step in 0..=32u32 {
        // A fade sweeping the full 16-bit perceptual range, densest at the bottom.
        let input = ((65535.0f64) * (step as f64 / 32.0).powi(3)) as u16;
        let linear = g.map_u16(input);
        let led = d.map_one(
            0,
            Rgb16 {
                r: linear,
                g: linear,
                b: linear,
            },
        );

        let eff = led.effective(0);
        let ideal = linear as f64 / 65535.0;

        // What you would get with PWM alone at full current: 8 bits, no more.
        let pwm_only = (linear as f64 / 65535.0 * PWM_MAX as f64).round() / PWM_MAX as f64;

        println!(
            "{:>8}  {:>8}  {:>6} {:>5}  {:>10.6}  {:>10.6}  {:>8.6}",
            input, linear, led.global, led.r, eff, ideal, pwm_only
        );
    }

    println!("\nThe bottom rows are the point: 'pwm-only' quantizes to 0 while the");
    println!("hybrid split still resolves the level. One PWM code at full current is");
    println!(
        "{:.6} of full scale; one code at global=1 is {:.6}.",
        1.0 / PWM_MAX as f64,
        1.0 / (PWM_MAX as f64 * GLOBAL_MAX as f64)
    );
}

/// Hold an unrepresentable level and watch the dither average onto it.
fn dither_convergence() {
    println!("== dither: mean effective output over 256 frames ==\n");
    println!(
        "{:>8}  {:>12}  {:>12}  {:>12}  {:>10}",
        "linear", "no dither", "dithered", "ideal", "err (codes)"
    );

    let code = 1.0 / (PWM_MAX as f64 * GLOBAL_MAX as f64);

    for v in [1u16, 3, 7, 40, 250, 1234, 20001] {
        let px = Rgb16 { r: v, g: v, b: v };

        let mut plain: Dimmer<1> = Dimmer::new(false);
        let flat = plain.map_one(0, px).effective(0);

        let mut dith: Dimmer<1> = Dimmer::new(true);
        let frames = 256;
        let mut sum = 0.0;
        for _ in 0..frames {
            sum += dith.map_one(0, px).effective(0);
        }
        let mean = sum / frames as f64;
        let ideal = v as f64 / 65535.0;

        println!(
            "{:>8}  {:>12.6}  {:>12.6}  {:>12.6}  {:>10.2}",
            v,
            flat,
            mean,
            ideal,
            (mean - ideal).abs() / code
        );
    }
}

/// The exact bytes that go out the SPI port.
fn frame_dump() {
    println!("== frame: {} LEDs, wire bytes ==\n", STRIP);

    let g = Gamma::G22;
    let mut d: Dimmer<STRIP> = Dimmer::new(true);

    // A dim warm gradient — the sort of thing that would expose banding.
    let px: Vec<Rgb16> = (0..STRIP)
        .map(|i| {
            let t = i as f64 / (STRIP - 1) as f64;
            let level = (t * 6000.0) as u16;
            Rgb16 {
                r: g.map_u16(level),
                g: g.map_u16(level / 3),
                b: g.map_u16(level / 12),
            }
        })
        .collect();

    let mut leds = vec![led_core::Led::OFF; STRIP];
    d.map(&px, &mut leds);

    let mut buf = vec![0u8; sk9822::frame_len(STRIP)];
    let n = sk9822::encode(&leds, &mut buf);

    println!(
        "frame_len({}) = {} bytes  ({} start + {} led + {} reset + {} end)",
        STRIP,
        n,
        4,
        4 * STRIP,
        4,
        sk9822::end_len(STRIP)
    );
    println!("4-byte aligned: {}\n", n.is_multiple_of(4));

    for (row, chunk) in buf.chunks(16).take(6).enumerate() {
        print!("{:04x}  ", row * 16);
        for b in chunk {
            print!("{b:02x} ");
        }
        println!();
    }
    println!("...");
    let tail = n - 16;
    print!("{tail:04x}  ");
    for b in &buf[tail..] {
        print!("{b:02x} ");
    }
    println!("   <- reset + end frame, all zeros");
}
