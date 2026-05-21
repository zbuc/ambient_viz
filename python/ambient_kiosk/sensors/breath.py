"""HR202 humidity sensor breath-puff detection via TLC555 oscillator.

The HR202 sits in the timing network of a TLC555 astable; the Pi counts
the 555's output edges on GPIO17. Breath puff -> HR202 resistance drops
-> oscillator frequency rises -> we detect that rise against a slow EMA
baseline.

This is a *trigger* application, not a measurement application. We don't
need precise frequency — only "did it just spike."

# Performance note (load-bearing)

The pigpio callback is registered ONCE and stays alive for the lifetime
of the driver. The sampling thread reads a running counter every
`BREATH_WINDOW_S` and diffs it against the previous sample. Do not
re-register/cancel the callback per window — at the worst-case ~10 kHz
edge rate, callback setup/teardown churn becomes a significant fraction
of one core. The handoff doc's example shows the per-window pattern for
clarity; this driver does NOT use that pattern.
"""

import logging
import threading
import time
from typing import Optional

from .. import config

log = logging.getLogger(__name__)


class BreathDriver:
    def __init__(self, ingest, pin: int = config.BREATH_PIN, mock: bool = False):
        self.ingest = ingest
        self.pin = pin
        self.mock = mock
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._pi = None
        self._cb = None
        # Edge counter — bumped from pigpio's callback thread. Reads from
        # the sampling thread don't need a lock; int reads are atomic in
        # CPython and we only diff snapshots.
        self._edge_count = 0
        # Detection state
        self._baseline: Optional[float] = None

    def _on_edge(self, gpio, level, tick) -> None:
        # Hot path. Keep trivial.
        self._edge_count += 1

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="breath", daemon=True)
        self._thread.start()

    def _init_pigpio(self) -> bool:
        try:
            import pigpio
            self._pi = pigpio.pi()
            if not self._pi.connected:
                log.error("breath: pigpio daemon not reachable — start it with `sudo systemctl start pigpiod`")
                return False
            self._pi.set_mode(self.pin, pigpio.INPUT)
            self._cb = self._pi.callback(self.pin, pigpio.RISING_EDGE, self._on_edge)
            log.info("breath: TLC555 edge counter on BCM%d", self.pin)
            return True
        except Exception as e:
            log.error("breath: pigpio init failed: %s", e)
            return False

    def _run(self) -> None:
        if not self.mock:
            if not self._init_pigpio():
                return
        else:
            log.info("breath: mock mode")

        window = config.BREATH_WINDOW_S
        warmup_windows = int(config.BREATH_WARMUP_S / window)
        windows_elapsed = 0
        debounce_until = 0.0
        last_count = self._edge_count
        last_t = time.monotonic()

        # Mock: synthetic edge generator. In real mode this is a no-op
        # because real edges arrive via the pigpio callback.
        mock_baseline_hz = 1500.0  # matches ~room baseline from handoff doc

        while not self._stop.wait(window):
            now = time.monotonic()
            if self.mock:
                # Synthesize a steady baseline frequency, with breath spikes
                # every ~12-18 seconds matching mock.js's general feel.
                phase = now % 14.5
                in_breath = 0.0 <= phase < 0.6  # ~600ms puff
                freq = mock_baseline_hz * (4.0 if in_breath else 1.0) + (hash(int(now * 7)) % 50)
            else:
                current = self._edge_count
                elapsed = now - last_t
                freq = (current - last_count) / elapsed if elapsed > 0 else 0.0
                last_count = current
                last_t = now

            # Warmup: seed baseline, no detection yet.
            if windows_elapsed < warmup_windows:
                if self._baseline is None:
                    self._baseline = freq
                else:
                    # Fast EMA during warmup so we settle quickly
                    self._baseline = 0.5 * self._baseline + 0.5 * freq
                windows_elapsed += 1
                continue

            # Breath detection
            if (now >= debounce_until
                    and self._baseline is not None
                    and self._baseline > 0
                    and freq > self._baseline * config.BREATH_TRIGGER_RATIO):
                ts_ms = int(time.time() * 1000)
                self.ingest.publish("breath_detected", ts_ms)
                log.info("breath: detected (freq=%.0f baseline=%.0f)", freq, self._baseline)
                debounce_until = now + config.BREATH_DEBOUNCE_S

            # Update baseline — but only while not in/near a breath event,
            # so the baseline doesn't drift up to track the breath itself.
            if now >= debounce_until and self._baseline is not None:
                a = config.BREATH_BASELINE_ALPHA
                self._baseline = (1 - a) * self._baseline + a * freq

    def stop(self) -> None:
        self._stop.set()
        if self._cb is not None:
            try:
                self._cb.cancel()
            except Exception:
                pass
        if self._pi is not None:
            try:
                self._pi.stop()
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=1.0)
