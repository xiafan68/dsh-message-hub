const state = {
  monitors: [],
  runs: [],
  overview: {},
  feed: [],
  curations: [],
  feedTotal: 0,
  feedPage: 0,
  feedPageSize: 20,
  curationKind: "daily",
  directions: [],
  draftDirections: [],
  directionsDirty: false,
  filter: "all",
  search: "",
};

const statusMeta = {
  active: ["运行中", "active"],
  degraded: ["需关注", "degraded"],
  error: ["异常", "error"],
  paused: ["已暂停", "paused"],
};

const runMeta = {
  changed: ["发现更新", "active"],
  no_change: ["无变化", "paused"],
  running: ["执行中", "active"],
  failed: ["运行失败", "error"],
  fetch_failed: ["抓取失败", "error"],
  extract_failed: ["解析失败", "error"],
  delivery_failed: ["投递失败", "degraded"],
};

document.addEventListener("DOMContentLoaded", () => {
  const initialView = viewFromHash();
  bindNavigation();
  bindFilters();
  document.querySelector("#refresh-button").addEventListener("click", refreshData);
  document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
  document.querySelector("#drawer-backdrop").addEventListener("click", closeDrawer);
  bindManagement();
  document.querySelector("#menu-button").addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("open"));
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeDrawer(); });
  ensureAuthenticated().then(authenticated => {
    if (!authenticated) return;
    showView(initialView, false);
    refreshData();
  });
});

window.addEventListener("hashchange", () => showView(viewFromHash(), false));

function viewFromHash() {
  const name = window.location.hash.slice(1);
  return ["overview", "monitors", "runs", "feed", "daily", "weekly", "settings"].includes(name) ? name : "overview";
}

async function ensureAuthenticated() {
  try {
    const health = await fetchJson("/api/v1/health");
    if (!health.write_protection) return true;
    const token = localStorage.getItem("messageSubscriptionsToken") || "";
    if (!token) { redirectToLogin(); return false; }
    await fetchJson("/api/v1/auth/session", { Authorization: `Bearer ${token}` });
    return true;
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      localStorage.removeItem("messageSubscriptionsToken");
      redirectToLogin();
      return false;
    }
    showToast(`登录状态检查失败：${error.message}`);
    return false;
  }
}

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/ui/login?next=${encodeURIComponent(next || "/ui")}`);
}

function bindNavigation() {
  document.querySelectorAll("[data-view], [data-go]").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view || button.dataset.go));
  });
}

function showView(name, persist = true) {
  const labels = { overview: "总览", monitors: "监控任务", runs: "运行记录", feed: "Feed 流", daily: "每日精选", weekly: "每周精选", settings: "关注方向" };
  if (persist) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${name}`);
  const target = ["daily", "weekly"].includes(name) ? "curations" : name;
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${target}`));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  document.querySelector("#current-page").textContent = labels[name];
  document.querySelector("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "feed") loadFeed();
  if (["daily", "weekly"].includes(name)) loadCurations(name);
}

function bindManagement() {
  const modal = document.querySelector("#monitor-modal");
  const backdrop = document.querySelector("#monitor-modal-backdrop");
  const close = () => { modal.classList.remove("open"); backdrop.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); };
  document.querySelector("#add-monitor-button").addEventListener("click", () => { modal.classList.add("open"); backdrop.classList.add("open"); modal.setAttribute("aria-hidden", "false"); });
  document.querySelector("#monitor-modal-close").addEventListener("click", close);
  document.querySelector("#monitor-modal-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.querySelector("#monitor-type").addEventListener("change", updateTypeFields);
  document.querySelector("#monitor-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const type = form.get("type");
    const payload = { id: form.get("id"), name: form.get("name"), type, tags: String(form.get("tags") || "").split(",").map(item => item.trim()).filter(Boolean) };
    if (["rss", "atom"].includes(type)) payload.url = form.get("url");
    if (type === "github_releases") payload.repository = form.get("repository");
    if (type === "web_page") payload.request = { url: form.get("web_url"), method: "GET", mode: "auto", timeout_seconds: 20 }, payload.extract = { type: "list", item_selector: form.get("item_selector"), fields: { title: { selector: form.get("title_selector"), value: "text" }, url: { selector: form.get("url_selector"), value: "href" } } }, payload.detect = { strategy: "new_item", initial_snapshot: "silent" };
    try { await writeJson("/api/v1/monitors", "POST", payload); close(); event.target.reset(); updateTypeFields(); await refreshData(); showToast("订阅已创建"); } catch (error) { handleWriteError(error); }
  });
  document.querySelector("#feed-filter-button").addEventListener("click", () => { state.feedPage = 0; loadFeed(); });
  document.querySelector("#feed-liked").addEventListener("change", () => { state.feedPage = 0; loadFeed(); });
  document.querySelector("#feed-prev").addEventListener("click", () => { if (state.feedPage > 0) { state.feedPage -= 1; loadFeed({ scrollToFirst: true }); } });
  document.querySelector("#feed-next").addEventListener("click", () => { if ((state.feedPage + 1) * state.feedPageSize < state.feedTotal) { state.feedPage += 1; loadFeed({ scrollToFirst: true }); } });
  document.querySelector("#save-directions").addEventListener("click", saveDirections);
  document.querySelector("#add-direction")?.addEventListener("click", () => addDirection(document.querySelector("#direction-new")?.value));
  document.querySelector("#direction-new")?.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === "," || event.key === "，") { event.preventDefault(); addDirection(event.target.value); } });
  document.querySelector("#direction-list")?.addEventListener("click", event => { const button = event.target.closest("[data-remove-direction]"); if (button) removeDirection(Number(button.dataset.removeDirection)); });
  document.querySelector("#reset-directions")?.addEventListener("click", resetDirections);
  document.querySelectorAll("[data-direction]").forEach(button => button.addEventListener("click", () => addDirection(button.dataset.direction)));
  document.querySelector("#save-token").addEventListener("click", () => { localStorage.setItem("messageSubscriptionsToken", document.querySelector("#api-token").value.trim()); showToast("管理 Token 已保存"); });
  document.querySelector("#api-token").value = localStorage.getItem("messageSubscriptionsToken") || "";
}

function updateTypeFields() {
  const type = document.querySelector("#monitor-type").value;
  document.querySelectorAll(".type-field").forEach(field => field.classList.toggle("hidden", !field.dataset.types.split(" ").includes(type)));
}

function bindFilters() {
  document.querySelector("#monitor-search").addEventListener("input", event => {
    state.search = event.target.value.trim().toLowerCase();
    renderMonitorTable();
  });
  document.querySelectorAll("#status-filters button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#status-filters button").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.status;
      renderMonitorTable();
    });
  });
}

async function refreshData() {
  const button = document.querySelector("#refresh-button");
  button.classList.add("loading");
  try {
    const [monitors, runs, overview, preferences] = await Promise.all([
      fetchJson("/api/v1/monitors"),
      fetchJson("/api/v1/runs?limit=40"),
      fetchJson("/api/v1/overview"),
      fetchJson("/api/v1/preferences"),
    ]);
    state.monitors = monitors.items;
    state.runs = runs.items;
    state.overview = overview;
    state.directions = preferences.directions;
    if (!state.directionsDirty) state.draftDirections = [...state.directions];
    renderAll();
    document.querySelector("#last-updated").textContent = `更新于 ${formatClock(new Date())}`;
  } catch (error) {
    showToast(`数据加载失败：${error.message}`);
  } finally {
    button.classList.remove("loading");
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const error = new Error(detail.detail || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function renderAll() {
  const overview = state.overview;
  setText("metric-active", overview.active_monitors ?? 0);
  setText("metric-attention", overview.attention_monitors ?? 0);
  setText("metric-new", overview.new_items_24h ?? 0);
  setText("metric-items", overview.total_items ?? 0);
  setText("nav-monitor-count", state.monitors.length);
  renderActivity();
  renderSourceChart();
  renderMonitorStrip();
  renderMonitorTable();
  renderRuns();
  renderFeedSources();
  renderDirectionEditor();
}

function renderActivity() {
  const container = document.querySelector("#overview-activity");
  const runs = state.runs.slice(0, 5);
  if (!runs.length) {
    container.innerHTML = emptyInline("暂无运行记录", "运行采集命令后，活动会显示在这里。");
    return;
  }
  container.innerHTML = runs.map(run => {
    const [label, tone] = runMeta[run.status] || [run.status, "paused"];
    const failed = ["error", "degraded"].includes(tone);
    return `<div class="activity-item">
      <span class="activity-symbol ${failed ? "error" : ""}">${failed ? warningIcon() : pulseIcon()}</span>
      <div class="activity-copy"><strong>${escapeHtml(monitorName(run.source_id))}</strong><small>${run.new_count ? `发现 ${run.new_count} 条新内容` : "完成一次内容检查"}</small></div>
      <div class="activity-time"><b class="${failed ? "error" : ""}">${escapeHtml(label)}</b>${relativeTime(run.finished_at || run.started_at)}</div>
    </div>`;
  }).join("");
}

function renderSourceChart() {
  const colors = ["#29725b", "#d1944b", "#5588a9", "#75679b", "#829088"];
  const labels = { rss: "RSS", atom: "Atom", github_releases: "GitHub", web_page: "网页" };
  const counts = state.monitors.reduce((result, monitor) => {
    result[monitor.type] = (result[monitor.type] || 0) + 1;
    return result;
  }, {});
  const entries = Object.entries(counts);
  const total = state.monitors.length || 1;
  let cursor = 0;
  const segments = entries.map(([type, count], index) => {
    const start = cursor;
    cursor += count / total * 100;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  });
  const donut = document.querySelector("#source-donut");
  donut.style.setProperty("--segments", `conic-gradient(${segments.join(",") || "#e7ece9 0 100%"})`);
  donut.querySelector("strong").textContent = state.monitors.length;
  document.querySelector("#source-legend").innerHTML = entries.map(([type, count], index) =>
    `<div class="legend-row"><i style="background:${colors[index % colors.length]}"></i><span>${labels[type] || escapeHtml(type)}</span><strong>${count}</strong></div>`
  ).join("");
}

function renderMonitorStrip() {
  const container = document.querySelector("#monitor-strip");
  if (!state.monitors.length) {
    container.innerHTML = emptyInline("尚未配置来源", "请先在 YAML 配置中添加监控。");
    return;
  }
  const sorted = [...state.monitors].sort((a, b) => statusOrder(a.status) - statusOrder(b.status)).slice(0, 3);
  container.innerHTML = sorted.map(monitor => `<div class="strip-item" data-monitor="${escapeAttr(monitor.id)}">
    ${sourceIcon(monitor.type)}<div><strong>${escapeHtml(monitor.name)}</strong><small>${statusMeta[monitor.status][0]} · ${monitor.item_count} 条内容</small></div>
  </div>`).join("");
  container.querySelectorAll("[data-monitor]").forEach(item => item.addEventListener("click", () => openDrawer(item.dataset.monitor)));
}

function renderMonitorTable() {
  const query = state.search;
  const monitors = state.monitors.filter(monitor => {
    const statusMatch = state.filter === "all" || monitor.status === state.filter || (state.filter === "degraded" && monitor.status === "error");
    const haystack = [monitor.id, monitor.name, monitor.type, ...monitor.tags].join(" ").toLowerCase();
    return statusMatch && (!query || haystack.includes(query));
  });
  const body = document.querySelector("#monitor-table-body");
  document.querySelector("#monitor-empty").classList.toggle("hidden", monitors.length > 0);
  body.innerHTML = monitors.map(monitor => {
    const [label, tone] = statusMeta[monitor.status];
    return `<tr data-monitor="${escapeAttr(monitor.id)}">
      <td><div class="monitor-name">${sourceIcon(monitor.type)}<div><strong>${escapeHtml(monitor.name)}</strong><small>${escapeHtml(monitor.url || monitor.id)}</small></div></div></td>
      <td><div class="status-stack"><span class="status-badge ${tone}">${label}</span><small>${monitor.enabled ? "已启用" : "已暂停"}</small></div></td>
      <td><span class="type-label">${escapeHtml(typeLabel(monitor.type))}</span></td>
      <td><span class="cell-strong">${monitor.item_count}</span></td>
      <td><span class="cell-muted">${relativeTime(monitor.last_run_at)}</span></td>
      <td><button class="row-action" aria-label="查看 ${escapeAttr(monitor.name)} 详情">${chevronIcon()}</button></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-monitor]").forEach(row => row.addEventListener("click", () => openDrawer(row.dataset.monitor)));
}

function renderRuns() {
  const container = document.querySelector("#run-list");
  if (!state.runs.length) {
    container.innerHTML = emptyInline("暂无运行记录", "执行一次采集后将在这里显示结果。");
    return;
  }
  container.innerHTML = state.runs.map(run => {
    const [label, tone] = runMeta[run.status] || [run.status, "paused"];
    return `<div class="run-row">
      <div class="run-source"><strong>${escapeHtml(monitorName(run.source_id))}</strong><small>${formatDateTime(run.started_at)}</small></div>
      <div><span class="status-badge ${tone}">${escapeHtml(label)}</span></div>
      <div class="run-count">${run.fetched_count}</div><div class="run-count">+${run.new_count}</div>
    </div>`;
  }).join("");
}

function openDrawer(id) {
  const monitor = state.monitors.find(item => item.id === id);
  if (!monitor) return;
  const [label, tone] = statusMeta[monitor.status];
  const tags = monitor.tags.length ? monitor.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("") : '<span class="cell-muted">无标签</span>';
  document.querySelector("#drawer-content").innerHTML = `
    <div class="drawer-hero">${sourceIcon(monitor.type)}<h2>${escapeHtml(monitor.name)}</h2><p>${escapeHtml(monitor.url || monitor.id)}</p></div>
    <div class="drawer-status"><span class="status-badge ${tone}">${label}</span><span>${monitor.enabled ? "已启用" : "已暂停"} · ${relativeTime(monitor.last_run_at)}</span></div>
    <section class="detail-section"><h3>运行配置</h3><div class="detail-grid">
      ${detailField("来源类型", typeLabel(monitor.type))}${detailField("轮询频率", `每 ${monitor.interval_minutes} 分钟`)}
      ${detailField("投递策略", deliveryLabel(monitor.delivery_mode))}${detailField("累计条目", `${monitor.item_count} 条`)}
      ${detailField("最近结果", monitor.last_status ? (runMeta[monitor.last_status]?.[0] || monitor.last_status) : "尚未运行")}${detailField("连续失败", String(monitor.consecutive_failures))}
    </div></section>
    <section class="detail-section"><h3>标签</h3><div class="tag-list">${tags}</div></section>
    ${monitor.last_error ? `<section class="detail-section"><h3>最近错误</h3><div class="error-box">${escapeHtml(monitor.last_error)}</div></section>` : ""}
    <div class="drawer-actions"><button class="secondary-button" data-monitor-action="run" data-id="${escapeAttr(monitor.id)}">立即运行</button><button class="secondary-button" data-monitor-action="toggle" data-id="${escapeAttr(monitor.id)}">${monitor.status === "paused" ? "恢复订阅" : "暂停订阅"}</button><button class="secondary-button danger wide" data-monitor-action="delete" data-id="${escapeAttr(monitor.id)}">删除订阅</button></div>`;
  document.querySelector("#detail-drawer").classList.add("open");
  document.querySelector("#detail-drawer").setAttribute("aria-hidden", "false");
  document.querySelector("#drawer-backdrop").classList.add("open");
  document.querySelectorAll("[data-monitor-action]").forEach(button => button.addEventListener("click", () => monitorAction(button.dataset.monitorAction, button.dataset.id)));
}

async function monitorAction(action, id) {
  try {
    if (action === "delete") {
      if (!window.confirm("确定删除这个订阅吗？历史 Feed 条目会保留。")) return;
      await writeJson(`/api/v1/monitors/${encodeURIComponent(id)}`, "DELETE");
    } else if (action === "toggle") {
      const monitor = state.monitors.find(item => item.id === id);
      await writeJson(`/api/v1/monitors/${encodeURIComponent(id)}/${monitor.status === "paused" ? "enable" : "disable"}`, "POST");
    } else {
      showToast("正在执行采集，请稍候…");
      await writeJson(`/api/v1/monitors/${encodeURIComponent(id)}/run`, "POST");
    }
    closeDrawer(); await refreshData(); showToast(action === "delete" ? "订阅已删除" : "操作已完成");
  } catch (error) { handleWriteError(error); }
}

function renderFeedSources() {
  const select = document.querySelector("#feed-source");
  const selected = select.value;
  select.innerHTML = '<option value="">全部来源</option>' + state.monitors.map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  select.value = selected;
}

async function loadFeed({ scrollToFirst = false } = {}) {
  const params = new URLSearchParams({ limit: String(state.feedPageSize), offset: String(state.feedPage * state.feedPageSize) });
  const values = { source_id: "feed-source", from_date: "feed-from", q: "feed-query" };
  Object.entries(values).forEach(([key, id]) => { const value = document.querySelector(`#${id}`).value.trim(); if (value) params.set(key, key === "from_date" ? `${value}T00:00:00+08:00` : value); });
  const to = document.querySelector("#feed-to").value;
  if (to) { const next = new Date(`${to}T00:00:00+08:00`); next.setDate(next.getDate() + 1); params.set("to_date", next.toISOString()); }
  const liked = document.querySelector("#feed-liked").value;
  if (liked) params.set("liked", liked === "liked" ? "true" : "false");
  try {
    const data = await fetchJson(`/api/v1/feed?${params}`); state.feed = data.items; state.feedTotal = data.total; setText("feed-total", data.total); renderFeed(); renderFeedPagination();
    if (scrollToFirst) document.querySelector("#feed-list .feed-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { showToast(`Feed 加载失败：${error.message}`); }
}

function renderFeedPagination() {
  const pageCount = Math.max(1, Math.ceil(state.feedTotal / state.feedPageSize));
  setText("feed-page", `${state.feedTotal ? state.feedPage + 1 : 0} / ${state.feedTotal ? pageCount : 0}`);
  const previous = document.querySelector("#feed-prev");
  const next = document.querySelector("#feed-next");
  previous.disabled = state.feedPage <= 0;
  next.disabled = state.feedPage >= pageCount - 1 || !state.feedTotal;
}

function renderFeed() {
  const container = document.querySelector("#feed-list");
  if (!state.feed.length) { container.innerHTML = emptyInline("暂无 Feed 内容", "先运行订阅采集，或调整筛选条件。"); return; }
  container.innerHTML = state.feed.map(item => `<article class="feed-card" tabindex="0" aria-expanded="false"><span class="feed-accent"></span><div><h2>${item.url ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h2><p>${escapeHtml(stripHtml(item.summary) || "暂无摘要")}</p><div class="feed-meta"><strong>${escapeHtml(item.source_name)}</strong><span>${formatDateTime(item.created_at)}</span>${item.author ? `<span>${escapeHtml(item.author)}</span>` : ""}</div></div><button class="feed-like ${item.liked ? "liked" : ""}" type="button" data-feed-like="${item.id}" aria-label="${item.liked ? "取消收藏" : "收藏"}" title="${item.liked ? "取消收藏" : "收藏"}">${item.liked ? "♥" : "♡"}</button>${item.url ? `<a class="feed-link" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${chevronIcon()}</a>` : ""}</article>`).join("");
  container.querySelectorAll("[data-feed-like]").forEach(button => button.addEventListener("click", async event => {
    event.stopPropagation();
    const item = state.feed.find(value => String(value.id) === button.dataset.feedLike);
    if (!item) return;
    try {
      const updated = await writeJson(`/api/v1/feed/${encodeURIComponent(item.id)}/like`, item.liked ? "DELETE" : "POST");
      item.liked = updated.liked;
      renderFeed();
      renderFeedPagination();
    } catch (error) { handleWriteError(error); }
  }));
  container.querySelectorAll(".feed-card").forEach(card => {
    const toggle = event => {
      if (event.target.closest("a")) return;
      const expanded = card.classList.toggle("expanded");
      card.setAttribute("aria-expanded", String(expanded));
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); }
    });
  });
}

async function loadCurations(kind) {
  state.curationKind = kind;
  setText("curation-heading", kind === "daily" ? "每日精选" : "每周精选");
  setText("curation-copy", kind === "daily" ? "从前一天内容中挑选最值得关注的信息。" : "从本周每日精选中提炼长期值得跟踪的重点。");
  const container = document.querySelector("#curation-list"); container.innerHTML = '<div class="skeleton-list"></div>';
  try {
    const list = await fetchJson(`/api/v1/curations?kind=${kind}&limit=20`);
    state.curations = await Promise.all(list.items.map(item => fetchJson(`/api/v1/curations/${item.id}`)));
    renderCurations();
  } catch (error) { showToast(`精选加载失败：${error.message}`); }
}

function renderCurations() {
  const container = document.querySelector("#curation-list");
  if (!state.curations.length) { container.innerHTML = emptyInline("尚未生成精选", state.curationKind === "daily" ? "每日 08:00 定时任务会生成前一天精选。" : "每周定时任务会从每日精选中提炼周度重点。"); return; }
  container.innerHTML = state.curations.map(collection => `<article class="curation-card"><header class="curation-header"><div><h2>${escapeHtml(collection.title)}</h2><p>${escapeHtml(collection.summary || "")}</p></div><span class="curation-date">${escapeHtml(collection.period_start)} — ${escapeHtml(collection.period_end)}</span></header><div class="curated-items">${collection.items.map((item, index) => `<div class="curated-item"><span class="curated-index">${index + 1}</span><div><h3>${item.url ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</h3>${item.html_body ? `<div class="curated-html">${sanitizeHtml(item.html_body)}</div>` : `<p>${escapeHtml(stripHtml(item.summary) || "暂无摘要")}</p>`}${item.rationale ? `<p class="curated-reason">入选理由：${escapeHtml(item.rationale)}</p>` : ""}<div class="curated-meta"><strong>${escapeHtml(item.source_name)}</strong><span>${formatDateTime(item.created_at)}</span><span>引用 ${(item.source_item_ids || []).length || (item.source_item_id ? 1 : 0)} 条 Feed</span></div></div></div>`).join("")}</div></article>`).join("");
}

function sanitizeHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  const allowed = new Set(["P", "UL", "OL", "LI", "STRONG", "EM", "A", "BLOCKQUOTE", "CODE"]);
  [...template.content.querySelectorAll("*")].forEach(element => {
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (!allowed.has(element.tagName)) { element.replaceWith(document.createTextNode(element.textContent || "")); return; }
    [...element.attributes].forEach(attribute => element.removeAttribute(attribute.name));
    if (element.tagName === "A" && href) {
      try {
        const url = new URL(href, window.location.origin);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid protocol");
        element.setAttribute("href", url.href); element.setAttribute("target", "_blank"); element.setAttribute("rel", "noopener");
      } catch { element.removeAttribute("href"); }
    }
  });
  return template.innerHTML;
}

function addDirection(value) {
  const direction = String(value || "").replace(/[，,]/g, "").trim();
  const input = document.querySelector("#direction-new");
  if (!direction) { input?.focus(); return; }
  if (state.draftDirections.some(item => item.toLowerCase() === direction.toLowerCase())) { showToast("这个方向已经在清单里了"); input?.select(); return; }
  if (state.draftDirections.length >= 12) { showToast("最多添加 12 个关注方向"); return; }
  state.draftDirections = [...state.draftDirections, direction];
  state.directionsDirty = true;
  if (input) input.value = "";
  renderDirectionEditor();
  input?.focus();
}

function removeDirection(index) {
  state.draftDirections = state.draftDirections.filter((_, itemIndex) => itemIndex !== index);
  state.directionsDirty = true;
  renderDirectionEditor();
}

function resetDirections() {
  state.draftDirections = [...state.directions];
  state.directionsDirty = false;
  renderDirectionEditor();
}

function renderDirectionEditor() {
  const directions = state.draftDirections || [];
  const legacyInput = document.querySelector("#direction-input");
  if (legacyInput) {
    legacyInput.value = directions.join("\n");
    setText("direction-count", `${directions.length} 个方向`);
    return;
  }
  const list = document.querySelector("#direction-list");
  const empty = document.querySelector("#direction-empty");
  if (!list || !empty) return;
  list.innerHTML = directions.map((direction, index) => `<span class="direction-tag">${escapeHtml(direction)}<button type="button" data-remove-direction="${index}" aria-label="删除 ${escapeAttr(direction)}">×</button></span>`).join("");
  empty.classList.toggle("hidden", directions.length > 0);
  setText("direction-count", `${directions.length} 个方向`);
  setText("direction-heading-count", directions.length);
  setText("direction-state", state.directionsDirty ? "有未保存修改" : "已同步");
  document.querySelector("#direction-state").classList.toggle("dirty", state.directionsDirty);
  document.querySelector("#reset-directions").classList.toggle("visible", state.directionsDirty);
  document.querySelectorAll("[data-direction]").forEach(button => {
    const exists = directions.some(item => item.toLowerCase() === button.dataset.direction.toLowerCase());
    button.disabled = exists;
    const marker = button.querySelector("span");
    if (marker) marker.textContent = exists ? "✓" : "＋";
  });
}

async function saveDirections() {
  const button = document.querySelector("#save-directions");
  button.disabled = true;
  try { const result = await writeJson("/api/v1/preferences", "PUT", { directions: state.draftDirections }); state.directions = result.directions; state.draftDirections = [...result.directions]; state.directionsDirty = false; renderDirectionEditor(); showToast("关注方向已保存"); } catch (error) { handleWriteError(error); } finally { button.disabled = false; }
}

async function writeJson(url, method, body) {
  const token = localStorage.getItem("messageSubscriptionsToken") || "";
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const detail = await response.json().catch(() => ({})); const error = new Error(detail.detail || `${response.status} ${response.statusText}`); error.status = response.status; throw error; }
  return response.status === 204 ? null : response.json();
}

function handleWriteError(error) { if ([401, 403].includes(error.status)) { showView("settings"); showToast("请先填写正确的管理 Token"); } else showToast(`操作失败：${error.message}`); }
function stripHtml(value) { if (!value) return ""; const node = document.createElement("div"); node.innerHTML = value; return node.textContent || ""; }

function closeDrawer() {
  document.querySelector("#detail-drawer").classList.remove("open");
  document.querySelector("#detail-drawer").setAttribute("aria-hidden", "true");
  document.querySelector("#drawer-backdrop").classList.remove("open");
}

function monitorName(id) { return state.monitors.find(item => item.id === id)?.name || id; }
function statusOrder(status) { return ({ error: 0, degraded: 1, active: 2, paused: 3 })[status] ?? 4; }
function typeLabel(type) { return ({ rss: "RSS Feed", atom: "Atom Feed", github_releases: "GitHub Releases", web_page: "网页监控" })[type] || type; }
function deliveryLabel(mode) { return ({ immediate: "即时通知", daily_digest: "每日摘要", digest: "定时摘要", silent: "仅归档" })[mode] || mode; }
function sourceIcon(type) { const text = ({ rss: "RSS", atom: "ATM", github_releases: "GH", web_page: "WEB" })[type] || "SRC"; return `<span class="source-icon">${text}</span>`; }
function detailField(label, value) { return `<div class="detail-field"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`; }
function setText(id, value) { const element = document.querySelector(`#${id}`); if (element) element.textContent = value; }
function formatClock(date) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date); }
function formatDateTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function relativeTime(value) {
  if (!value) return "尚未运行";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (Number.isNaN(seconds)) return "时间未知";
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return "刚刚";
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function escapeAttr(value) { return escapeHtml(value); }
function showToast(message) { const toast = document.querySelector("#toast"); toast.textContent = message; toast.classList.add("show"); window.setTimeout(() => toast.classList.remove("show"), 3000); }
function emptyInline(title, copy) { return `<div class="empty-state"><h3>${title}</h3><p>${copy}</p></div>`; }
function pulseIcon() { return '<svg viewBox="0 0 24 24"><path d="M4 12h4l2-5 4 10 2-5h4"/></svg>'; }
function warningIcon() { return '<svg viewBox="0 0 24 24"><path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4M12 17h.01"/></svg>'; }
function chevronIcon() { return '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>'; }
