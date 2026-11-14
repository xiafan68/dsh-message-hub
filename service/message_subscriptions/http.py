from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urljoin

import httpx

from .models import FetchResult, SourceState
from .security import validate_public_url


class FetchError(RuntimeError):
    pass


class HttpFetcher:
    def __init__(self, user_agent: str = "message-subscriptions/0.1", max_bytes: int = 5_000_000):
        self.user_agent = user_agent
        self.max_bytes = max_bytes

    def fetch(
        self,
        url: str,
        *,
        state: SourceState | None = None,
        headers: Mapping[str, str] | None = None,
        timeout_seconds: float = 20,
    ) -> FetchResult:
        request_headers = {"User-Agent": self.user_agent, "Accept": "*/*"}
        request_headers.update(headers or {})
        if state and state.etag:
            request_headers["If-None-Match"] = state.etag
        if state and state.last_modified:
            request_headers["If-Modified-Since"] = state.last_modified

        current_url = url
        with httpx.Client(timeout=timeout_seconds, follow_redirects=False) as client:
            for _ in range(6):
                validate_public_url(current_url)
                try:
                    with client.stream("GET", current_url, headers=request_headers) as response:
                        if response.status_code == 304:
                            return FetchResult(current_url, 304, b"", dict(response.headers))
                        if response.is_redirect:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchError("重定向响应缺少 Location")
                            current_url = urljoin(current_url, location)
                            continue
                        response.raise_for_status()
                        body = bytearray()
                        for chunk in response.iter_bytes():
                            body.extend(chunk)
                            if len(body) > self.max_bytes:
                                raise FetchError(f"响应超过 {self.max_bytes} 字节限制")
                        return FetchResult(current_url, response.status_code, bytes(body), dict(response.headers))
                except httpx.HTTPError as exc:
                    raise FetchError(f"请求失败: {exc}") from exc
        raise FetchError("重定向次数超过限制")
