#!/usr/bin/env python3
"""Standalone VL53L1X bringup sanity check.

Run with the kiosk venv active:

    cd python && source .venv/bin/activate
    python test_vl53l1x.py

Prints live readings plus rolling mean/stddev over the last ~1 s window,
so you can validate accuracy (vs a tape measure) and noise floor (target
held steady) before plugging into the full kiosk pipeline. Ctrl-C to exit.
"""

import collections
import statistics
import sys
import time

try:
    import board
    import busio
    import adafruit_vl53l1x
except ImportError as e:
    print(f"missing dep: {e}", file=sys.stderr)
    print("activate the kiosk venv first: cd python && source .venv/bin/activate", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    i2c = busio.I2C(board.SCL, board.SDA)
    try:
        sensor = adafruit_vl53l1x.VL53L1X(i2c)
    except Exception as e:
        print(f"VL53L1X not found at 0x29: {e}", file=sys.stderr)
        print("check `i2cdetect -y 1` first — 0x29 must be visible", file=sys.stderr)
        return 1

    sensor.distance_mode = 1   # 1 = short (<1.5 m, best accuracy + ambient light immunity)
    sensor.timing_budget = 20
    sensor.start_ranging()

    print("VL53L1X ready: short mode, 20 ms timing budget")
    print("hold target steady to read noise floor; wave to track motion")
    print("ambient = scene IR load (ST ULD units). Compare projector ON vs OFF,")
    print("on the real wall, to tune VL53_AMBIENT_LONG_MAX in config.py.")
    print("ctrl-c to exit\n")
    print(f"{'raw':>10}   {'mean(1s)':>10}   {'sd':>6}   {'amb':>6}   {'n':>3}")

    def read_ambient():
        # ST ULD VL53L1_RESULT__AMBIENT_COUNT_RATE_MCPS_SD0; not exposed by
        # the Adafruit API, so read it raw (word * 8). Mirrors the kiosk
        # driver's _read_ambient_rate so the printed number matches what
        # auto-mode-select sees at boot.
        try:
            raw = sensor._read_register(0x0090, 2)
            return ((raw[0] << 8) | raw[1]) * 8
        except Exception:
            return None

    window = collections.deque(maxlen=50)  # ~1 s at 50 Hz
    last_print = 0.0
    last_d = None
    last_amb = None
    try:
        while True:
            if sensor.data_ready:
                d = sensor.distance  # cm, or None when no valid target in cone
                last_amb = read_ambient()
                sensor.clear_interrupt()
                last_d = d
                if d is not None:
                    window.append(d)
            now = time.monotonic()
            if now - last_print >= 0.1:
                raw_s = f"{last_d:6.1f} cm" if last_d is not None else "    --   "
                amb_s = f"{last_amb:>6d}" if last_amb is not None else f"{'--':>6}"
                if len(window) >= 2:
                    mu = statistics.mean(window)
                    sd = statistics.stdev(window)
                    print(f"{raw_s:>10}   {mu:6.1f} cm   {sd:5.2f}   {amb_s}   {len(window):>3}",
                          end="\r", flush=True)
                else:
                    print(f"{raw_s:>10}   {'--':>10}   {'--':>6}   {amb_s}   {len(window):>3}",
                          end="\r", flush=True)
                last_print = now
            time.sleep(0.005)
    except KeyboardInterrupt:
        print()
        if len(window) >= 2:
            print(f"final: n={len(window)} "
                  f"mean={statistics.mean(window):.1f} cm "
                  f"sd={statistics.stdev(window):.2f} cm")
        sensor.stop_ranging()
    return 0


if __name__ == "__main__":
    sys.exit(main())
