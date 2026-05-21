"""Entrypoint: start ingest + all sensor drivers, run until SIGINT/SIGTERM."""

import argparse
import logging
import os
import signal
import sys
import threading

from . import config
from .ingest import Ingest
from .sensors.breath import BreathDriver
from .sensors.distance import DistanceDriver
from .sensors.pir import PirDriver
from .sensors.touch import TouchDriver

log = logging.getLogger("ambient_kiosk")


def main() -> int:
    p = argparse.ArgumentParser(prog="ambient-kiosk")
    p.add_argument("--mock", action="store_true",
                   help="Run without hardware; generate synthetic sensor data. "
                        "For Mac-side end-to-end testing of the Python→Node→browser pipeline.")
    p.add_argument("--url", default=config.INGEST_URL,
                   help=f"Ingest URL (default {config.INGEST_URL})")
    p.add_argument("--debug", action="store_true", help="Verbose logging")
    p.add_argument("--no-pir", action="store_true", help="Skip the PIR driver")
    p.add_argument("--no-distance", action="store_true", help="Skip the distance driver")
    p.add_argument("--no-breath", action="store_true", help="Skip the breath driver")
    p.add_argument("--no-touch", action="store_true", help="Skip the touch driver")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    ingest = Ingest(url=args.url, token=os.environ.get("INGEST_TOKEN", ""))
    ingest.start()

    drivers = []
    if not args.no_pir:
        drivers.append(PirDriver(ingest, mock=args.mock))
    if not args.no_distance:
        drivers.append(DistanceDriver(ingest, mock=args.mock))
    if not args.no_breath:
        drivers.append(BreathDriver(ingest, mock=args.mock))
    if not args.no_touch:
        drivers.append(TouchDriver(ingest, mock=args.mock))

    for d in drivers:
        d.start()

    log.info("running (%s; %d drivers; ingest -> %s)",
             "mock" if args.mock else "hardware",
             len(drivers), args.url)

    stop_event = threading.Event()

    def _handler(signum, frame):
        log.info("signal %d received, shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)

    try:
        stop_event.wait()
    finally:
        for d in drivers:
            try:
                d.stop()
            except Exception as e:
                log.warning("driver %s stop failed: %s", type(d).__name__, e)
        ingest.stop()
        log.info("clean exit")

    return 0


if __name__ == "__main__":
    sys.exit(main())
