#!/usr/bin/env python3
"""CLI test for the Daisy WebUSB-bulk audio capture path.

Firmware: build with the `usb-bulk` feature (`cargo flash-sdmmc-bulk`), which
exposes audio on a vendor (class 0xFF) BULK IN endpoint instead of the UAC iso
source. This script is a faithful proxy for the browser: WebUSB does exactly what
libusb/pyusb does here — claim the vendor interface and read the bulk IN endpoint.
If this streams clean PCM (ESPECIALLY with the CDC POS channel concurrently
active, via --pos), the browser AudioWorklet path will too, and we've de-risked
the full implementation before writing any JS.

The point of `--pos`: UAC iso dies the instant CDC runs alongside it on the Pi 4
VL805. Bulk+bulk should NOT — so run with --pos and confirm throughput holds and
POS lines flow at the same time. That is the whole bet.

Usage:
    sudo python3 bulk_capture_test.py [SECONDS] [--pos] [--out FILE]
        SECONDS   capture duration (default 10)
        --pos     ALSO read /dev/ttyACM0 (CDC POS) concurrently — the exact
                  iso-killing scenario. Bulk should survive it.
        --out     raw output (default /tmp/daisy_bulk.raw; s16le 48k stereo)

Deps:   sudo apt install libusb-1.0-0 && pip3 install pyusb   (pyserial optional)
Listen: ffmpeg -f s16le -ar 48000 -ac 2 -i /tmp/daisy_bulk.raw /tmp/daisy_bulk.wav
"""
import struct
import sys
import threading
import time

VID, PID = 0x1209, 0xDA15  # matches firmware dev_cfg (pid.codes / Daisy audio source)


def read_pos(stop, path="/dev/ttyACM0"):
    """Read CDC POS lines concurrently to exercise the bulk+CDC contention case."""
    try:
        fh = open(path, "rb", buffering=0)  # cdc_acm tty; baud is ignored
    except Exception as e:
        print(f"[pos] could not open {path}: {e}  (is the firmware emitting POS?)")
        return
    print(f"[pos] reading {path} concurrently (exercising CDC + bulk together)")
    n, buf = 0, b""
    while not stop.is_set():
        try:
            d = fh.read(64)
        except Exception:
            break
        if not d:
            continue
        buf += d
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            n += 1
            if n % 20 == 0:  # ~1/s at 20 POS/s
                print(f"[pos] {line.decode(errors='replace').strip()}")
    print(f"[pos] {n} CDC lines read")


def main():
    import usb.core
    import usb.util

    args = sys.argv[1:]
    do_pos = "--pos" in args
    out = args[args.index("--out") + 1] if "--out" in args else "/tmp/daisy_bulk.raw"
    secs = 10.0
    for a in args:
        if not a.startswith("--"):
            try:
                secs = float(a)
            except ValueError:
                pass
            break

    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        sys.exit(f"device {VID:04x}:{PID:04x} not found (flash `cargo flash-sdmmc-bulk`?)")

    # Do NOT set_configuration — it would reset the device and drop CDC. Read the
    # already-active config the host set at enumeration.
    cfg = dev.get_active_configuration()
    vintf = next((i for i in cfg if i.bInterfaceClass == 0xFF), None)
    if vintf is None:
        sys.exit("no vendor (0xFF) interface — is this the `usb-bulk` firmware?")
    ep = usb.util.find_descriptor(
        vintf,
        custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN
        and usb.util.endpoint_type(e.bmAttributes) == usb.util.ENDPOINT_TYPE_BULK,
    )
    if ep is None:
        sys.exit("vendor interface has no bulk IN endpoint")
    ifnum = vintf.bInterfaceNumber
    print(f"vendor interface {ifnum}, bulk IN ep 0x{ep.bEndpointAddress:02x}, mps {ep.wMaxPacketSize}")

    if dev.is_kernel_driver_active(ifnum):
        dev.detach_kernel_driver(ifnum)
    usb.util.claim_interface(dev, ifnum)

    stop = threading.Event()
    if do_pos:
        threading.Thread(target=read_pos, args=(stop,), daemon=True).start()

    total, peak, sumsq, nsamp = 0, 0, 0.0, 0
    REQ = 4096  # bytes per read (multiple of 64-byte bulk packet)
    t0 = time.time()
    with open(out, "wb") as f:
        while time.time() - t0 < secs:
            try:
                data = dev.read(ep.bEndpointAddress, REQ, timeout=2000)
            except usb.core.USBError as e:
                if getattr(e, "errno", None) == 110:  # ETIMEDOUT
                    print("[bulk] read timeout — device not streaming on the bulk EP?")
                    continue
                print(f"[bulk] USBError: {e}")
                break
            b = data.tobytes()
            f.write(b)
            total += len(b)
            for i in range(0, len(b) - 1, 64):  # subsample for liveness
                v = struct.unpack_from("<h", b, i)[0]
                peak = max(peak, abs(v))
                sumsq += v * v
                nsamp += 1
    dt = time.time() - t0 or 1e-9
    stop.set()
    usb.util.release_interface(dev, ifnum)

    rate = total / dt
    rms = (sumsq / nsamp) ** 0.5 if nsamp else 0
    print(f"\n=== bulk capture: {total} bytes in {dt:.1f}s ===")
    print(f"throughput : {rate/1000:6.1f} KB/s   (expect ~192 KB/s = 48k x 2ch x 2B; real-time)")
    print(f"liveness   : peak |sample| {peak}/32767, rms {rms:.0f}  ->  "
          f"{'SILENT / no audio' if peak < 50 else 'AUDIO PRESENT'}")
    print(f"raw        : {out}")
    print(f"listen     : ffmpeg -f s16le -ar 48000 -ac 2 -i {out} {out.rsplit('.', 1)[0]}.wav")


if __name__ == "__main__":
    main()
