"""VL53L1X time-of-flight distance sensor over I²C.

Polls at ~50 Hz, smooths with an exponential moving average, publishes
`distance_cm`. Invalid reads (no target in cone) decay smoothed value
toward `far` rather than freezing.
"""

import logging
import threading
import time
from typing import Optional

from .. import config

log = logging.getLogger(__name__)


class DistanceDriver:
    # Seconds with no valid read before we start decaying the smoothed
    # value toward VL53_FAR_CM. Below this, the value is held so that
    # intermittent None reads (which happen constantly on a real sensor)
    # don't bias the published value toward "far" while a target is
    # genuinely present.
    NO_TARGET_TIMEOUT_S = 2.0

    def __init__(self, ingest, mock: bool = False):
        self.ingest = ingest
        self.mock = mock
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._sensor = None
        self._i2c = None
        self._smoothed: Optional[float] = None
        self._last_published: Optional[float] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="distance", daemon=True)
        self._thread.start()

    def _init_sensor(self) -> bool:
        try:
            import board
            import busio
            import adafruit_vl53l1x
            self._i2c = busio.I2C(board.SCL, board.SDA)
            self._sensor = adafruit_vl53l1x.VL53L1X(self._i2c, address=config.VL53L1X_ADDR)
            self._sensor.distance_mode = config.VL53_DISTANCE_MODE
            self._sensor.timing_budget = config.VL53_TIMING_BUDGET_MS
            self._sensor.start_ranging()
            log.info("distance: VL53L1X ready (mode=%d, budget=%dms)",
                     config.VL53_DISTANCE_MODE, config.VL53_TIMING_BUDGET_MS)
            return True
        except Exception as e:
            log.error("distance: VL53L1X init failed: %s", e)
            return False

    def _read_raw(self) -> Optional[float]:
        """Returns distance in cm, or None for no-target / invalid."""
        try:
            if not self._sensor.data_ready:
                return None
            d = self._sensor.distance  # cm; None if no valid target
            self._sensor.clear_interrupt()
            return float(d) if d is not None else None
        except Exception as e:
            log.debug("distance: read error: %s", e)
            return None

    def _run(self) -> None:
        period = 1.0 / config.VL53_PUBLISH_HZ
        if not self.mock:
            if not self._init_sensor():
                return
        else:
            log.info("distance: mock mode")

        # Mock state
        cycle_start = time.monotonic()
        CYCLE = 25.0

        # Wall-clock of the last valid (non-None) read. Stays 0.0 until the
        # first one arrives, so initial published value is FAR (idle).
        last_valid_t = 0.0

        while not self._stop.wait(period):
            if self.mock:
                t = ((time.monotonic() - cycle_start) % CYCLE) / CYCLE
                if t < 0.05 or t >= 0.85:
                    raw = 200.0
                elif t < 0.35:
                    raw = 200.0 - (t - 0.05) / 0.30 * 170.0
                elif t < 0.65:
                    raw = 30.0 + 3.0 * (0.5 - abs((t - 0.50) * 4))  # tiny breathing wobble
                else:
                    raw = 30.0 + (t - 0.65) / 0.20 * 170.0
            else:
                raw = self._read_raw()

            now = time.monotonic()
            a = config.VL53_SMOOTH_ALPHA
            if raw is not None:
                # Valid read — smooth into existing trace.
                last_valid_t = now
                self._smoothed = raw if self._smoothed is None else (a * raw + (1 - a) * self._smoothed)
            elif last_valid_t == 0.0 or (now - last_valid_t) > self.NO_TARGET_TIMEOUT_S:
                # Sustained no-target — decay toward FAR so the visualizer
                # eventually idles when nobody is in the cone.
                target = config.VL53_FAR_CM
                self._smoothed = target if self._smoothed is None else (a * target + (1 - a) * self._smoothed)
            # else: brief None during a known-present target — hold value.

            # Quantize publication to 0.1 cm to suppress trivial JSON noise
            if self._smoothed is not None:
                v = round(self._smoothed, 1)
                if v != self._last_published:
                    self.ingest.publish("distance_cm", v)
                    self._last_published = v

    def stop(self) -> None:
        self._stop.set()
        if self._sensor is not None:
            try:
                self._sensor.stop_ranging()
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=1.0)
