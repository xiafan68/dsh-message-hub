from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlsplit


class UnsafeUrlError(ValueError):
    pass


def _allowed_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """可选的 CIDR 白名单（默认空 = 维持原有严格行为）。

    为什么需要它：本机开了 Clash TUN / fake-ip 之类的代理时，DNS 会把所有域名
    解析到保留网段（常见 198.18.0.0/16），于是 is_global 判定失败，采集全部被拦。
    这不是真的在请求内网地址，而是本机代理的地址映射。

    出于安全考虑**默认关闭**：只有显式设置
    `MESSAGE_SUBSCRIPTIONS_ALLOW_CIDRS`（逗号分隔的 CIDR）才放行这些网段。
    配错的值会被忽略并保留严格行为，避免"以为开了白名单其实开了全网"。
    """
    raw = os.environ.get("MESSAGE_SUBSCRIPTIONS_ALLOW_CIDRS", "")
    if not raw.strip():
        return []
    networks = []
    for item in raw.split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            networks.append(ipaddress.ip_network(candidate, strict=False))
        except ValueError:
            continue
    return networks


def _is_permitted(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_global:
        return True
    return any(ip in network for network in _allowed_networks())


def validate_public_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise UnsafeUrlError("只允许包含主机名的 HTTP(S) URL")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"无法解析目标主机 {parsed.hostname}") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not _is_permitted(ip):
            raise UnsafeUrlError(f"目标主机解析到非公网地址: {ip}")