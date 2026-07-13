//! The chip-agnostic LED render core: linear color, hybrid dimming, SK9822 framing.
//!
//! This crate is to `node-fw` what `dsp` is to the Daisy `firmware`: all of the
//! behavior, none of the hardware. It runs unchanged on the Mac (`host`) so fade
//! quality can be judged and regression-tested without a strip attached.
//!
//! The pipeline is: perceptual input -> [`color::Gamma`] -> linear [`color::Rgb16`]
//! -> [`dim::Dimmer`] -> [`dim::Led`] (5-bit global + 8-bit PWM) -> [`sk9822::encode`]
//! -> bytes for SPI.

#![cfg_attr(not(test), no_std)]

pub mod color;
pub mod dim;
pub mod sk9822;

pub use color::{Gamma, Rgb16, Rgb8};
pub use dim::{Dimmer, Led};
