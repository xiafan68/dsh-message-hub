from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class ConfigError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class AppConfig:
    defaults: dict[str, Any]
    sources: tuple[dict[str, Any], ...]
    destinations: dict[str, dict[str, Any]]
    policies: dict[str, Any]


def validate_source_config(source: dict[str, Any]) -> None:
    source_id = _required_text(source, "id", "source")
    source_type = _required_text(source, "type", f"来源 {source_id}")
    if source_type not in {"rss", "atom", "github_releases", "web_page"}:
        raise ConfigError(f"来源 {source_id} 使用了不支持的 type: {source_type}")
    _validate_source(source)
    _reject_inline_secrets(source)


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path)
    try:
        document = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise ConfigError(f"无法读取配置 {config_path}: {exc}") from exc
    if not isinstance(document, dict):
        raise ConfigError("配置根节点必须是对象")

    defaults = _mapping(document.get("defaults"), "defaults")
    destinations = _mapping(document.get("destinations"), "destinations")
    policies = _mapping(document.get("policies"), "policies")
    source_values = document.get("sources", [])
    if not isinstance(source_values, list):
        raise ConfigError("sources 必须是数组")

    sources: list[dict[str, Any]] = []
    source_ids: set[str] = set()
    for index, value in enumerate(source_values):
        if not isinstance(value, dict):
            raise ConfigError(f"sources[{index}] 必须是对象")
        source = _deep_merge(defaults, value)
        source_id = _required_text(source, "id", f"sources[{index}]")
        source_type = _required_text(source, "type", f"sources[{index}]")
        if source_type not in {"rss", "atom", "github_releases", "web_page"}:
            raise ConfigError(f"来源 {source_id} 使用了不支持的 type: {source_type}")
        if source_id in source_ids:
            raise ConfigError(f"来源 id 重复: {source_id}")
        source_ids.add(source_id)
        _validate_source(source)
        sources.append(source)

    _reject_inline_secrets(document)
    return AppConfig(defaults, tuple(sources), destinations, policies)


def _validate_source(source: dict[str, Any]) -> None:
    source_id = source["id"]
    source_type = source["type"]
    if source_type in {"rss", "atom"}:
        _required_text(source, "url", f"来源 {source_id}")
    elif source_type == "github_releases":
        repository = _required_text(source, "repository", f"来源 {source_id}")
        if repository.count("/") != 1:
            raise ConfigError(f"来源 {source_id} 的 repository 必须是 owner/name")
    elif source_type == "web_page":
        request = _mapping(source.get("request"), f"来源 {source_id}.request")
        _required_text(request, "url", f"来源 {source_id}.request")
        extract = _mapping(source.get("extract"), f"来源 {source_id}.extract")
        selectors = [extract.get("item_selector"), extract.get("item_selectors"), extract.get("collections")]
        if sum(value is not None for value in selectors) != 1:
            raise ConfigError(
                f"来源 {source_id} 必须且只能配置 item_selector、item_selectors、collections 之一"
            )
        if extract.get("collections") is None and not isinstance(extract.get("fields"), dict):
            raise ConfigError(f"来源 {source_id}.extract.fields 必须是对象")


def _mapping(value: Any, name: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ConfigError(f"{name} 必须是对象")
    return value


def _required_text(value: dict[str, Any], key: str, name: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ConfigError(f"{name}.{key} 必须是非空字符串")
    return result.strip()


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _reject_inline_secrets(value: Any, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            lowered = key.lower()
            if any(marker in lowered for marker in ("password", "secret", "token", "cookie")):
                is_scalar = not isinstance(child, (dict, list))
                if is_scalar and child not in (None, "") and not lowered.endswith(("_env", "_ref")):
                    raise ConfigError(f"{child_path} 不允许保存明文密钥，请使用 *_env 或 *_ref")
            _reject_inline_secrets(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_inline_secrets(child, f"{path}[{index}]")
