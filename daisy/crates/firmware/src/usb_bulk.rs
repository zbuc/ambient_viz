//! Vendor-class BULK IN audio endpoint for live capture over WebUSB.
//!
//! Alternative to the UAC1 isochronous source (`usb_audio` + `uac_source`),
//! selected by the `usb-bulk` feature. The Raspberry Pi 4's VL805 xHCI cannot
//! reliably schedule Full-Speed **isochronous + bulk** to the same composite
//! device, so the UAC capture drops ~100% of frames whenever the CDC channel is
//! also active (proven: clean on macOS + idle Pi, total drop on the loaded Pi;
//! see daisy/PLAN_USB_CAPTURE.md and memory `daisy-webusb-bulk-decision`). Moving
//! audio onto a **bulk** endpoint removes the periodic schedule the VL805 chokes
//! on, and the browser reads it directly with `navigator.usb` → AudioWorklet,
//! bypassing the getUserMedia/PipeWire capture graph entirely.
//!
//! Wire format: raw interleaved **stereo i16 little-endian** PCM @ 48 kHz — the
//! exact bytes teed into `USB_RING`, no header; the browser reassembles. The CDC
//! ACM (POS out / MIDI in) is a *separate* interface and is untouched: the kernel
//! keeps `/dev/ttyACM0`, WebUSB claims only this vendor interface, so the POS
//! bridge and the audio capture run concurrently with no contention.

use core::sync::atomic::Ordering;

use embassy_futures::select::{Either, select};
use embassy_time::{Duration, Timer};
use embassy_usb::Builder;
use embassy_usb::driver::{Driver, Endpoint, EndpointIn};
use heapless::spsc::Consumer;

use crate::USB_RING_LEN;
use crate::usb_audio::Drv;
use crate::{USB_CAPTURING, USB_PKT_MAX_FR};

/// Vendor-specific class — no kernel driver binds it, so WebUSB is permitted to
/// `claimInterface` it (a CDC/audio class interface would be kernel-owned).
const VENDOR_CLASS: u8 = 0xFF;
const VENDOR_SUBCLASS: u8 = 0x00;
const VENDOR_PROTOCOL: u8 = 0x00;
/// Full-speed bulk wMaxPacketSize (the FS bulk maximum). 64 B = 16 i16 = 8 stereo
/// frames per packet; the host coalesces many packets per `transferIn`.
const BULK_MAX_PACKET: u16 = 64;

/// The concrete bulk IN endpoint type for our OTG-FS driver.
type BulkEpIn = <Drv as Driver<'static>>::EndpointIn;

/// If no host pulls a packet within this long, treat capture as idle. A BULK IN
/// has no "host detached" event (unlike iso alt-setting disable), so we infer it
/// from a stalled write. Must be comfortably longer than the gap a *reading*
/// host leaves between transfers (sub-ms when pipelined) so active streaming
/// never trips it.
const IDLE_MS: u64 = 250;

/// Add the vendor function + a single bulk IN endpoint to the composite device.
/// Returns the endpoint to stream audio on. No control handler, no alt settings —
/// a vendor interface needs none, and the endpoint is live once the host issues
/// SET_CONFIGURATION.
pub fn build(builder: &mut Builder<'static, Drv>) -> BulkEpIn {
    let mut func = builder.function(VENDOR_CLASS, VENDOR_SUBCLASS, VENDOR_PROTOCOL);
    let mut iface = func.interface();
    let mut alt = iface.alt_setting(VENDOR_CLASS, VENDOR_SUBCLASS, VENDOR_PROTOCOL, None);
    // `endpoint_bulk_in` allocates the EP *and writes its standard endpoint
    // descriptor* (NoSynchronization/DataEndpoint). The low-level
    // `alloc_endpoint_in` does NOT write the descriptor — using it alone enumerates
    // the interface with zero endpoints, so the host (and WebUSB) sees no bulk IN.
    alt.endpoint_bulk_in(None, BULK_MAX_PACKET)
}

/// Drain the SAI tee ring into the bulk IN endpoint. Unlike the UAC iso task,
/// `write` has **no 1 ms deadline**: it blocks until the host (`transferIn`) reads
/// the packet, so a slow/absent reader just back-pressures here instead of
/// dropping a poll. Samples only drop if the ring overflows while the host isn't
/// reading (counted via `USB_DROP` in the tee, gated by `USB_CAPTURING`).
#[embassy_executor::task]
pub async fn stream_task(mut ep: BulkEpIn, mut samples: Consumer<'static, i16, USB_RING_LEN>) {
    let mut pkt = [0u8; BULK_MAX_PACKET as usize];
    loop {
        ep.wait_enabled().await;
        crate::dbg_uart!("usb-bulk: endpoint enabled — waiting for a reader");
        // Endpoint enabled != someone reading it. Stay "not capturing" (so the tee
        // doesn't count drops) and drop any backlog until a host actually pulls a
        // packet below.
        USB_CAPTURING.store(false, Ordering::Relaxed);
        while samples.dequeue().is_some() {}
        loop {
            // Fill one max-size packet from the ring, a whole stereo FRAME (L,R)
            // at a time so a packet boundary never splits a pair — otherwise the
            // byte stream goes off by one sample and the consumer swaps L/R (and
            // the total isn't a multiple of 4 → "Invalid PCM packet"). pkt.len()
            // is 64, a multiple of 4, so full packets are exactly 16 frames.
            let mut len = 0;
            while len + 4 <= pkt.len() {
                let Some(l) = samples.dequeue() else { break };
                let r = samples.dequeue().unwrap_or(0);
                pkt[len..len + 2].copy_from_slice(&l.to_le_bytes());
                pkt[len + 2..len + 4].copy_from_slice(&r.to_le_bytes());
                len += 4;
            }
            if len == 0 {
                // Ring momentarily empty — yield so the producer (audio task) can
                // refill, then retry. Bulk has no deadline, so the gap is harmless.
                embassy_futures::yield_now().await;
                continue;
            }
            // DIAG: peak single-write drain in stereo frames (reuses the UAC
            // counter so the same rtt-diag heartbeat reads both paths).
            USB_PKT_MAX_FR.fetch_max((len / 4) as u32, Ordering::Relaxed);
            // Bound the write: with no reader, `write` parks waiting for the
            // previous transfer to drain (host IN token) and never returns. A
            // BULK IN has no detach event, so a stalled write IS the "nobody's
            // listening" signal. Cancelling it on timeout is safe — it's pending
            // in the register-poll phase, before any FIFO write. On idle we flip
            // USB_CAPTURING off (the tee stops counting drops → usb_drop=0 instead
            // of pinning at 192000) and dump the backlog so a returning reader
            // gets fresh audio, not a ring of stale samples.
            match select(ep.write(&pkt[..len]), Timer::after(Duration::from_millis(IDLE_MS))).await {
                Either::First(Ok(())) => USB_CAPTURING.store(true, Ordering::Relaxed),
                Either::First(Err(_)) => {
                    crate::dbg_uart!("usb-bulk: endpoint disabled");
                    USB_CAPTURING.store(false, Ordering::Relaxed);
                    break;
                }
                Either::Second(_) => {
                    USB_CAPTURING.store(false, Ordering::Relaxed);
                    while samples.dequeue().is_some() {}
                }
            }
        }
    }
}
