"""POSTs `{name, value}` batches to the Node SSE bridge's /ingest endpoint.

Bounded in-memory queue; if Node is unreachable, oldest items are
dropped. Old kiosk readings have no replay value, so we'd rather lose
them than block sensor threads.
"""

import collections
import logging
import os
import threading
import time
from typing import Any, Optional

import requests

from . import config

log = logging.getLogger(__name__)


class Ingest:
    def __init__(
        self,
        url: str = config.INGEST_URL,
        token: Optional[str] = None,
        batch_ms: int = config.INGEST_BATCH_MS,
        queue_max: int = config.INGEST_QUEUE_MAX,
        timeout_s: float = config.INGEST_TIMEOUT_S,
    ):
        self.url = url
        self.token = token if token is not None else os.environ.get("INGEST_TOKEN", "")
        self.batch_s = batch_ms / 1000.0
        self.timeout_s = timeout_s
        self._queue: collections.deque = collections.deque(maxlen=queue_max)
        self._cond = threading.Condition()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._session = requests.Session()
        self._consecutive_failures = 0

    def publish(self, name: str, value: Any) -> None:
        """Enqueue a value for the next flush. Non-blocking; safe from any thread."""
        with self._cond:
            self._queue.append({"name": name, "value": value})
            self._cond.notify()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="ingest", daemon=True)
        self._thread.start()

    def stop(self, drain_timeout_s: float = 1.0) -> None:
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=drain_timeout_s)
        try:
            self._flush_locked(self._drain())  # best-effort final flush
        except Exception:
            pass
        self._session.close()

    def _drain(self) -> list:
        with self._cond:
            items = list(self._queue)
            self._queue.clear()
        return items

    def _run(self) -> None:
        while not self._stop.is_set():
            with self._cond:
                if not self._queue:
                    self._cond.wait(timeout=self.batch_s)
                    if self._stop.is_set():
                        break
                items = list(self._queue)
                self._queue.clear()
            if items:
                self._flush_locked(items)
            else:
                # Tiny sleep so we don't busy-spin if notify() raced with stop.
                time.sleep(self.batch_s)

    def _flush_locked(self, items: list) -> None:
        if not items:
            return
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-Ingest-Token"] = self.token
        try:
            r = self._session.post(self.url, json=items, headers=headers, timeout=self.timeout_s)
            if r.status_code >= 400:
                self._consecutive_failures += 1
                if self._consecutive_failures == 1 or self._consecutive_failures % 50 == 0:
                    log.warning("ingest %s: %s %s", self.url, r.status_code, r.text[:120])
            else:
                if self._consecutive_failures > 0:
                    log.info("ingest recovered after %d failures", self._consecutive_failures)
                self._consecutive_failures = 0
        except requests.RequestException as e:
            self._consecutive_failures += 1
            if self._consecutive_failures == 1 or self._consecutive_failures % 50 == 0:
                log.warning("ingest %s unreachable (%s); dropping %d items",
                            self.url, e.__class__.__name__, len(items))
