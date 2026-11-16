"""Polite HTTP client: browser-like headers, per-host spacing, retries with back-off."""
from __future__ import annotations

import random
import time
from urllib.parse import urlparse

import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
RETRY_STATUS = {429, 500, 502, 503, 504}


class FetchError(RuntimeError):
    """A request failed after all retries, or was refused."""


class Http:
    def __init__(self, min_interval: float = 0.4, timeout: float = 30.0, retries: int = 4):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "*/*"})
        self.min_interval = min_interval
        self.timeout = timeout
        self.retries = retries
        self._last: dict[str, float] = {}

    def _wait(self, host: str) -> None:
        gap = time.monotonic() - self._last.get(host, 0.0)
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last[host] = time.monotonic()

    def get(self, url: str, params: dict | None = None) -> requests.Response | None:
        """Return the response, or None for 404 (which for NSE means "no file")."""
        host = urlparse(url).netloc
        last_err = "unknown"
        for attempt in range(self.retries + 1):
            self._wait(host)
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as exc:
                last_err = f"{type(exc).__name__}: {exc}"
            else:
                if resp.status_code == 200:
                    return resp
                if resp.status_code == 404:
                    return None
                last_err = f"HTTP {resp.status_code}"
                if resp.status_code not in RETRY_STATUS:
                    raise FetchError(f"{last_err} for {url}")
            if attempt < self.retries:
                time.sleep(min(60.0, 2.0 ** (attempt + 1)) + random.uniform(0, 1))
        raise FetchError(f"{last_err} for {url} after {self.retries + 1} attempts")
