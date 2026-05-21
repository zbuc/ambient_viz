"""MPR121 12-channel capacitive touch over I²C, IRQ-driven on GPIO27.

The MPR121 pulls IRQ low when any channel's touch/release state changes.
We watch the IRQ pin with gpiozero and read the 12-bit state register
only on those edges — no polling.

Publishes `touch_mask` (12-bit int) whenever the state changes.
"""

import logging
import threading
import time
from typing import Optional

from .. import config

log = logging.getLogger(__name__)


class TouchDriver:
    def __init__(self, ingest, irq_pin: int = config.TOUCH_IRQ_PIN, mock: bool = False):
        self.ingest = ingest
        self.irq_pin = irq_pin
        self.mock = mock
        self._stop = threading.Event()
        self._mock_thread: Optional[threading.Thread] = None
        self._mpr = None
        self._irq_button = None
        self._last_mask = -1

    def start(self) -> None:
        if self.mock:
            self._mock_thread = threading.Thread(target=self._mock_loop, name="touch-mock", daemon=True)
            self._mock_thread.start()
            log.info("touch: mock mode")
            return
        try:
            import board
            import busio
            import adafruit_mpr121
            from gpiozero import Button
            i2c = busio.I2C(board.SCL, board.SDA)
            self._mpr = adafruit_mpr121.MPR121(i2c, address=config.MPR121_ADDR)
            # MPR121 IRQ is active-low and pulses when state changes.
            # gpiozero.Button with pull_up=True + when_pressed handles
            # the falling edge cleanly.
            self._irq_button = Button(self.irq_pin, pull_up=True, bounce_time=None)
            self._irq_button.when_pressed = self._on_irq
            log.info("touch: MPR121 + IRQ on BCM%d", self.irq_pin)
            self._on_irq()  # seed initial state
        except Exception as e:
            log.error("touch: init failed: %s", e)

    def _on_irq(self) -> None:
        if self._mpr is None:
            return
        try:
            # touched_pins returns a tuple of 12 booleans, lowest-numbered first.
            mask = 0
            for i, t in enumerate(self._mpr.touched_pins):
                if t:
                    mask |= 1 << i
            if mask != self._last_mask:
                self.ingest.publish("touch_mask", mask)
                self._last_mask = mask
        except Exception as e:
            log.debug("touch: irq read failed: %s", e)

    def _mock_loop(self) -> None:
        import random
        mask = 0
        rng = random.Random(0xC0FFEE)  # deterministic-ish
        while not self._stop.wait(1.5):
            if rng.random() < 0.3:
                mask |= 1 << rng.randrange(12)
            else:
                set_bits = [i for i in range(12) if mask & (1 << i)]
                if set_bits:
                    mask &= ~(1 << rng.choice(set_bits))
            if mask != self._last_mask:
                self.ingest.publish("touch_mask", mask)
                self._last_mask = mask

    def stop(self) -> None:
        self._stop.set()
        if self._irq_button is not None:
            try:
                self._irq_button.close()
            except Exception:
                pass
        if self._mock_thread is not None:
            self._mock_thread.join(timeout=0.5)
