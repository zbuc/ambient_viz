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
    print("ctrl-c to exit\n")
    print(f"{'raw':>10}   {'mean(1s)':>10}   {'sd':>6}   {'n':>3}")

    window = collections.deque(maxlen=50)  # ~1 s at 50 Hz
    last_print = 0.0
    last_d = None
    try:
        while True:
            if sensor.data_ready:
                d = sensor.distance  # cm, or None when no valid target in cone
                sensor.clear_interrupt()
                last_d = d
                if d is not None:
                    window.append(d)
            now = time.monotonic()
            if now - last_print >= 0.1:
                raw_s = f"{last_d:6.1f} cm" if last_d is not None else "    --   "
                if len(window) >= 2:
                    mu = statistics.mean(window)
                    sd = statistics.stdev(window)
                    print(f"{raw_s:>10}   {mu:6.1f} cm   {sd:5.2f}   {len(window):>3}",
                          end="\r", flush=True)
                else:
                    print(f"{raw_s:>10}   {'--':>10}   {'--':>6}   {len(window):>3}",
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
