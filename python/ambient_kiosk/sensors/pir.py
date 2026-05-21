"""AM312 PIR motion sensor on GPIO4.

Publishes `motion` (bool) on every state transition. Suppresses all
events for the first 60s post-process-start so the AM312's settling
phase doesn't false-trigger.
"""

import logging
import threading
import time

from .. import config

log = logging.getLogger(__name__)


class PirDriver:
    def __init__(self, ingest, pin: int = config.PIR_PIN, mock: bool = False):
        self.ingest = ingest
        self.pin = pin
        self.mock = mock
        self._start_t = 0.0
        self._sensor = None
        self._mock_thread = None
        self._stop = threading.Event()

    def _suppressed(self) -> bool:
        return (time.monotonic() - self._start_t) < config.PIR_BOOT_SUPPRESS_S

    def _emit(self, value: bool) -> None:
        if self._suppressed():
            return
        self.ingest.publish("motion", value)

    def start(self) -> None:
        self._start_t = time.monotonic()
        if self.mock:
            self._mock_thread = threading.Thread(target=self._mock_loop, name="pir-mock", daemon=True)
            self._mock_thread.start()
            log.info("pir: mock mode")
            return
        # Lazy import: gpiozero only installs on Pi
        from gpiozero import MotionSensor
        self._sensor = MotionSensor(self.pin)
        self._sensor.when_motion = lambda: self._emit(True)
        self._sensor.when_no_motion = lambda: self._emit(False)
        log.info("pir: AM312 on BCM%d (suppressing %.0fs post-boot)",
                 self.pin, config.PIR_BOOT_SUPPRESS_S)
        # Seed initial state (might be high if someone happens to be there at boot)
        self._emit(bool(self._sensor.motion_detected))

    def _mock_loop(self) -> None:
        # Toggle every ~10s with some jitter; track expected state.
        state = False
        while not self._stop.wait(8 + (hash(time.monotonic()) & 7)):
            state = not state
            self._emit(state)

    def stop(self) -> None:
        self._stop.set()
        if self._sensor is not None:
            try:
                self._sensor.close()
            except Exception:
                pass
        if self._mock_thread is not None:
            self._mock_thread.join(timeout=0.5)
