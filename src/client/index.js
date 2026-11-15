/**
 * client/index.js —— 消息订阅面板的浏览器半边（DSH client plugin bundle）。
 *
 * 手写 `window.__ModuleLoader__.load({id, factory})` 形态：执行只注册 factory，
 * 所有副作用（含 CSS 注入）都在物化时发生。
 *
 * 槽位：
 *   - `sidebar.panellist`        左侧栏入口（图标 + 文案）
 *   - `main` (keyed)             主区域三栏大页：订阅源 / 条目流 / 详情
 *   - `conversation.input.dock`  无头桥，拿到当前会话的草稿写入动作
 *
 * 数据全部来自宿主 BFF `/message-hub/api/*`（见 src/server.mjs），浏览器不直连 Python 服务：
 * 写接口要 Bearer Token，token 不该进浏览器。
 *
 * 三个交互是这一版的全部理由：
 *   1. 选中条目 → 「写进对话草稿」，不自动发送；
 *   2. 选中即上报 → 模型用 hub_selection 就能知道用户此刻在看什么；
 *   3. 空态/服务不可达时不白屏，给可执行的下一步（启动服务 / 重试）。
 */

window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-message-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var jsx = require("react/jsx-runtime");

		//#region 常量
		/** 左侧栏入口与主面板共用的 id（两者必须一致，否则面板选不中）。 */
		var PANEL_ID = "message-hub";
		/** 文案命名空间。 */
		var NS = "messageHub";
		/** 宿主 BFF 前缀（与 src/server.mjs 的 ROUTE_PREFIX 一致）。 */
		var API_PREFIX = "/message-hub/api";
		/** 一屏默认条数。 */
		var PAGE_SIZE = 50;
		//#endregion

		//#region 文案
		var zh = {
			panel: "消息订阅",
			title: "消息订阅",
			subtitle: "RSS · 网页 · GitHub Releases",
			sources: "订阅源",
			allSources: "全部来源",
			feed: "条目流",
			detail: "详情",
			search: "搜索标题 / 摘要",
			likedOnly: "只看收藏",
			refresh: "刷新",
			loading: "加载中…",
			noItems: "没有匹配的条目",
			noSelection: "选一条消息看详情",
			noSources: "还没有订阅源：在对话里说「帮我订 XX 的 RSS」就能加",
			serviceDown: "本机订阅引擎没在跑",
			serviceDownHint: "面板要连内置的订阅引擎（127.0.0.1:4001）。点下面按钮让插件拉起它；首次会自动安装依赖，可能要几分钟。",
			startService: "启动服务",
			starting: "正在启动…（首次会安装依赖，请稍候）",
			retry: "重试",
			error: "出错了",
			open: "打开原文",
			like: "收藏",
			unlike: "取消收藏",
			toChat: "写进对话草稿",
			copy: "复制引用",
			copied: "引用已复制",
			inserted: "已写入当前会话草稿（未自动发送）",
			noSession: "还没有可写入的会话：先在对话里发过消息，或先打开聊天面板",
			rejected: "草稿正在提交或已锁定，稍后再点一次",
			chatHint: "只写进草稿，不会自动发送；模型也能用 hub_selection 读到你在面板里选中的内容。",
			itemsCount: "{n} 条",
			pageInfo: "第 {page} / {pages} 页 · 共 {total} 条",
			prev: "上一页",
			next: "下一页",
			sourceLabel: "来源",
			timeLabel: "时间",
			noSummary: "（这条没有摘要）",
			sessionScope: "当前选中会同步给对话",
			openInChat: "把这个引用到对话",
			runNow: "立刻采集",
			running: "采集中…",
			runDone: "采集完成：新增 {n} 条",
			runFailed: "采集失败：{msg}",
			runAll: "全部采集",
			runAllTitle: "采集所有启用的订阅源",
			runAllBusy: "采集中 {done}/{total}",
			runAllDone: "全部采集完成：新增 {n} 条",
			runAllFail: "全部采集完成：{ok} 个成功，{fail} 个失败",
			runAllEmpty: "没有启用的订阅源",
			pauseFeed: "暂停",
			resumeFeed: "恢复",
			deleteFeed: "删除",
			confirmDeleteFeed: "确认删除",
			feedPaused: "已暂停该源",
			feedResumed: "已恢复该源",
			feedDeleted: "已删除该源",
			typeRss: "RSS",
			typeWeb: "网页",
			typeGithub: "GitHub",
			lastRun: "上次",
			paused: "已暂停",
			unread: "条目",
			tabFeed: "条目流",
			tabDigest: "每日精选",
			tabPrefs: "关注偏好",
			digest: "每日精选",
			digestSub: "按你的关注方向，从当天条目里挑出来的",
			digestEmpty: "还没有精选内容",
			digestEmptyHint: "精选由服务端生成（scripts/curation_*.py 写入 curation_collections）；这里会显示 daily / weekly 各期。",
			digestKindDaily: "日报",
			digestKindWeekly: "周报",
			digestItems: "{n} 条精选",
			rationale: "入选理由",
			noDigestSelected: "左边选一期看内容",
			prefs: "关注偏好",
			prefsHint: "这些方向决定每日精选的取舍口径。改完保存即生效（写服务端 preferences 表）。",
			prefsEmpty: "还没有设置关注方向",
			prefsPlaceholder: "例如：AI Agent 工程化",
			prefsAdd: "添加",
			prefsSave: "保存",
			prefsSaved: "已保存",
			prefsDirty: "有未保存的改动",
			prefsRemove: "移除",
			back: "返回",
			collection: "期次",
		};
		var en = {
			panel: "Message Hub",
			title: "Message Hub",
			subtitle: "RSS · web pages · GitHub Releases",
			sources: "Sources",
			allSources: "All sources",
			feed: "Feed",
			detail: "Detail",
			search: "Search title / summary",
			likedOnly: "Liked only",
			refresh: "Refresh",
			loading: "Loading…",
			noItems: "Nothing matches",
			noSelection: "Pick an item to see details",
			noSources: "No sources yet: ask the assistant to add an RSS feed",
			serviceDown: "The local engine is not running",
			serviceDownHint: "The panel talks to the bundled engine on 127.0.0.1:4001. Let the plugin start it; the first run installs Python dependencies and may take a few minutes.",
			startService: "Start service",
			starting: "Starting… (first run installs dependencies)",
			retry: "Retry",
			error: "Something went wrong",
			open: "Open link",
			like: "Like",
			unlike: "Unlike",
			toChat: "Write to chat draft",
			copy: "Copy reference",
			copied: "Reference copied",
			inserted: "Written to the current chat draft (not sent)",
			noSession: "No writable session yet: send one message in chat first",
			rejected: "The draft is submitting or locked; try again",
			chatHint: "Draft only — nothing is sent. The model can also read your selection via hub_selection.",
			itemsCount: "{n} items",
			pageInfo: "Page {page} / {pages} · {total} items",
			prev: "Prev",
			next: "Next",
			sourceLabel: "Source",
			timeLabel: "Time",
			noSummary: "(no summary)",
			sessionScope: "Selection is mirrored to the conversation",
			openInChat: "Reference this in chat",
			runNow: "Collect now",
			running: "Collecting…",
			runDone: "Collected: {n} new",
			runFailed: "Collection failed: {msg}",
			runAll: "Collect all",
			runAllTitle: "Collect every enabled source",
			runAllBusy: "Collecting {done}/{total}",
			runAllDone: "Collected: {n} new",
			runAllFail: "Done: {ok} ok, {fail} failed",
			runAllEmpty: "No enabled sources",
			pauseFeed: "Pause",
			resumeFeed: "Resume",
			deleteFeed: "Delete",
			confirmDeleteFeed: "Confirm delete",
			feedPaused: "Source paused",
			feedResumed: "Source resumed",
			feedDeleted: "Source deleted",
			typeRss: "RSS",
			typeWeb: "Web",
			typeGithub: "GitHub",
			lastRun: "last",
			paused: "Paused",
			unread: "items",
			tabFeed: "Feed",
			tabDigest: "Daily digest",
			tabPrefs: "Focus areas",
			digest: "Daily digest",
			digestSub: "Picked from today's items along your focus areas",
			digestEmpty: "No digest yet",
			digestEmptyHint: "Digests are produced server-side (scripts/curation_*.py); daily and weekly editions appear here.",
			digestKindDaily: "Daily",
			digestKindWeekly: "Weekly",
			digestItems: "{n} picks",
			rationale: "Why it was picked",
			noDigestSelected: "Pick an edition on the left",
			prefs: "Focus areas",
			prefsHint: "These directions decide what the daily digest keeps. Saving writes them to the service.",
			prefsEmpty: "No focus areas yet",
			prefsPlaceholder: "e.g. AI agent engineering",
			prefsAdd: "Add",
			prefsSave: "Save",
			prefsSaved: "Saved",
			prefsDirty: "Unsaved changes",
			prefsRemove: "Remove",
			back: "Back",
			collection: "Edition",
		};
		//#endregion

		//#region 纯工具
		function fill(template, vars) {
			return String(template).replace(/\{(\w+)\}/g, function (m, key) {
				return vars && vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : m;
			});
		}

		function intFmt(value) {
			var n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toLocaleString();
		}

		/** 相对时间：条目流里"3 小时前"比 ISO 串好读。 */
		function relTime(value, nowMs) {
			if (!value) return "—";
			var ts = Date.parse(String(value));
			if (!Number.isFinite(ts)) return String(value).slice(0, 16);
			var diff = Math.max(0, (nowMs || Date.now()) - ts);
			var min = Math.floor(diff / 60000);
			if (min < 1) return "刚刚";
			if (min < 60) return min + " 分钟前";
			var hour = Math.floor(min / 60);
			if (hour < 24) return hour + " 小时前";
			var day = Math.floor(hour / 24);
			if (day < 30) return day + " 天前";
			return String(value).slice(0, 10);
		}

		function typeLabel(type, t) {
			if (type === "rss" || type === "atom" || type === "json_feed") return t("typeRss");
			if (type === "github_releases") return t("typeGithub");
			return t("typeWeb");
		}

		/** 摘要洗成单行：条目正文里有换行和富文本残余，直接塞进列表会很乱。 */
		function oneLine(value, max) {
			var text = String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
			var limit = max || 160;
			return text.length > limit ? text.slice(0, limit) + "…" : text;
		}

		/** 面板 → 对话的引用文本。故意写成"人读得懂 + 模型抓得住"的形态。 */
		function referenceFor(selection) {
			if (!selection) return "";
			var lines = [];
			if (selection.kind === "source") {
				lines.push("【消息订阅 · 订阅源】" + (selection.title || selection.id));
				if (selection.url) lines.push("地址：" + selection.url);
				if (selection.summary) lines.push(oneLine(selection.summary, 300));
			} else {
				lines.push("【消息订阅】" + (selection.title || "(无标题)"));
				if (selection.source_name) lines.push("来源：" + selection.source_name);
				if (selection.created_at) lines.push("时间：" + selection.created_at);
				if (selection.url) lines.push("链接：" + selection.url);
				if (selection.summary) lines.push(oneLine(selection.summary, 600));
			}
			return lines.join("\n");
		}

		function apiUrl(path) {
			return API_PREFIX + path;
		}

		function getJson(path) {
			return fetch(apiUrl(path), { headers: { Accept: "application/json" } }).then(function (response) {
				return response.json().then(function (body) {
					if (!response.ok) {
						var err = new Error((body && (body.message || body.code)) || ("HTTP " + response.status));
						err.payload = body;
						err.status = response.status;
						throw err;
					}
					return body;
				});
			});
		}

		function sendJson(path, method, payload) {
			return fetch(apiUrl(path), {
				method: method,
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: payload === undefined ? undefined : JSON.stringify(payload),
			}).then(function (response) {
				return response.text().then(function (raw) {
					var body = null;
					try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
					if (!response.ok) {
						var err = new Error((body && (body.message || body.code)) || ("HTTP " + response.status));
						err.payload = body;
						err.status = response.status;
						throw err;
					}
					return body;
				});
			});
		}
		//#endregion

		//#region 样式
		var CSS = [
			".mh-root{display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--dsw-colors-text-primary,#1f2328);}",
			".mh-header{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--dsw-colors-border-muted,#e6e9ec);flex:0 0 auto;}",
			".mh-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.2px;}",
			".mh-sub{color:var(--dsw-colors-text-muted,#6b7480);font-size:11.5px;}",
			".mh-dot{width:7px;height:7px;border-radius:50%;background:#2da44e;display:inline-block;}",
			".mh-dot.off{background:#cf222e;}",
			".mh-spacer{margin-left:auto;}",
			".mh-btn{height:28px;padding:0 11px;border:1px solid var(--dsw-colors-border-muted,#d8dee4);border-radius:8px;background:var(--dsw-colors-bg-default,#fff);color:inherit;font:inherit;font-size:12px;cursor:pointer;}",
			".mh-btn:hover{background:var(--dsw-colors-bg-subtle,#f3f5f7);}",
			".mh-btn:disabled{opacity:.5;cursor:default;}",
			".mh-btn.primary{background:#297a5b;border-color:#297a5b;color:#fff;}",
			".mh-btn.primary:hover{background:#236a4f;}",
			".mh-btn.danger{color:#b42318;}",
			".mh-btn.danger:hover{border-color:#f0b4ae;background:#fdf1f0;}",
			".mh-btn.danger.armed{background:#fdecea;border-color:#e9a29b;color:#a11a10;}",
			".mh-btn.sm{height:22px;padding:0 8px;font-size:11px;border-radius:6px;}",
			".mh-col-head .mh-btn{text-transform:none;letter-spacing:0;}",
			".mh-body{display:grid;grid-template-columns:210px minmax(0,1fr) 390px;flex:1;min-height:0;}",
			".mh-col{min-height:0;overflow:auto;border-right:1px solid var(--dsw-colors-border-muted,#eceff1);}",
			".mh-col:last-child{border-right:0;}",
			".mh-col-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--dsw-colors-bg-default,#fff);border-bottom:1px solid var(--dsw-colors-border-muted,#f0f2f4);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-colors-text-muted,#6b7480);}",
			".mh-src{display:flex;flex-direction:column;gap:2px;padding:10px;}", 
			".mh-src-item{display:block;width:100%;text-align:left;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;}",
			".mh-src-item:hover{background:var(--dsw-colors-bg-subtle,#f3f5f7);}",
			".mh-src-item.on{background:#e8f2ed;color:#1d5c44;font-weight:600;}",
			".mh-src-name{display:flex;align-items:center;gap:6px;font-size:12.5px;}",
			".mh-src-meta{color:var(--dsw-colors-text-muted,#6b7480);font-size:11px;}",
			".mh-toolbar{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-colors-border-muted,#f0f2f4);}",
			".mh-input{flex:1;height:28px;padding:0 9px;border:1px solid var(--dsw-colors-border-muted,#d8dee4);border-radius:8px;background:var(--dsw-colors-bg-default,#fff);color:inherit;font:inherit;font-size:12px;outline:0;}",
			".mh-input:focus{border-color:#82ad9b;box-shadow:0 0 0 3px rgba(41,114,91,.08);}",
			".mh-toggle{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-colors-text-muted,#6b7480);white-space:nowrap;}",
			".mh-item{display:block;width:100%;text-align:left;padding:10px 13px;border:0;border-bottom:1px solid var(--dsw-colors-border-muted,#f2f4f5);background:transparent;color:inherit;font:inherit;cursor:pointer;}",
			".mh-item:hover{background:var(--dsw-colors-bg-subtle,#f7f9fa);}",
			".mh-item.on{background:#eef6f2;}",
			".mh-item-title{font-size:13px;font-weight:600;line-height:1.45;margin:0 0 3px;}",
			".mh-item-sum{color:var(--dsw-colors-text-muted,#6b7480);font-size:12px;margin:0;}", 
			".mh-item-meta{display:flex;gap:8px;align-items:center;color:var(--dsw-colors-text-muted,#8792a2);font-size:11px;margin-top:4px;}",
			".mh-star{color:#bf8700;}",
			".mh-detail{padding:16px 16px 28px;}",
			".mh-detail h3{margin:0 0 6px;font-size:16px;line-height:1.4;}",
			".mh-detail-meta{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-colors-text-muted,#6b7480);font-size:12px;margin-bottom:10px;}",
			".mh-detail p{font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word;}",
			".mh-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px;}",
			".mh-note{color:var(--dsw-colors-text-muted,#8792a2);font-size:11.5px;margin-top:6px;}",
			".mh-empty{padding:44px 18px;text-align:center;color:var(--dsw-colors-text-muted,#6b7480);font-size:12.5px;}",
			".mh-err{margin:12px;padding:10px 12px;border:1px solid #f0c2c0;border-radius:9px;background:#fff5f5;color:#8a1f1a;font-size:12.5px;}",
			".mh-toast{position:sticky;bottom:0;margin:0;padding:8px 14px;background:#1d3a2f;color:#fff;font-size:12px;text-align:center;}",
			".mh-tabs{display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-colors-border-muted,#e6e9ec);flex:0 0 auto;}",
			".mh-tab{height:28px;padding:0 12px;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;}",
			".mh-tab:hover{background:var(--dsw-colors-bg-subtle,#f3f5f7);}",
			".mh-tab.on{border-bottom-color:#297a5b;color:#1d5c44;font-weight:600;}",
			".mh-body.digest{grid-template-columns:330px minmax(0,1fr);}",
			".mh-digest-item{display:block;width:100%;text-align:left;padding:10px 13px;border:0;border-bottom:1px solid var(--dsw-colors-border-muted,#f2f4f5);background:transparent;color:inherit;font:inherit;cursor:pointer;}",
			".mh-digest-item:hover{background:var(--dsw-colors-bg-subtle,#f7f9fa);}",
			".mh-digest-item.on{background:#eef6f2;}",
			".mh-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px;}",
			".mh-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;background:#eef6f2;color:#1d5c44;font-size:12px;}",
			".mh-chip button{border:0;background:transparent;color:#1d5c44;cursor:pointer;font:inherit;line-height:1;padding:0;}",
			".mh-prefs{padding:14px 16px 24px;max-width:760px;}",
			".mh-row{display:flex;align-items:center;gap:8px;padding:0 16px 12px;}",
			".mh-pager{display:flex;align-items:center;gap:8px;padding:9px 12px;color:var(--dsw-colors-text-muted,#6b7480);font-size:11.5px;}",
			".mh-tag{display:inline-block;padding:0 6px;border-radius:5px;background:var(--dsw-colors-bg-subtle,#f1f3f5);font-size:10.5px;color:var(--dsw-colors-text-muted,#6b7480);}",
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined") return;
			var id = "dsh-message-hub-style";
			if (document.getElementById(id)) return;
			var node = document.createElement("style");
			node.id = id;
			node.textContent = CSS;
			(document.head || document.body).appendChild(node);
		}
		//#endregion

		//#region 会话桥
		/** 最近一次挂载的会话输入动作（dock 的 inject(sessionId) 提供）。 */
		var chatBridge = { current: { sessionId: "", actions: null, notify: null } };

		function insertToComposer(text) {
			var bridge = chatBridge.current;
			if (!bridge || !bridge.actions || typeof bridge.actions.insertText !== "function") {
				return { ok: false, reason: "no-session" };
			}
			for (var attempt = 0; attempt < 2; attempt += 1) {
				try {
					var span = typeof bridge.actions.captureInsertion === "function"
						? bridge.actions.captureInsertion()
						: undefined;
					if (bridge.actions.insertText(text, span) === true) return { ok: true };
				} catch (e) { /* 草稿正在切换：下一轮重试 */ }
			}
			return { ok: false, reason: "rejected", hasBridge: true };
		}

		function copyText(text) {
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(text);
					return true;
				}
			} catch (e) { /* 退回手动复制 */ }
			return false;
		}
		//#endregion

		//#region 状态
		function initialQuery() {
			return { q: "", sourceId: "", likedOnly: false, limit: PAGE_SIZE, offset: 0 };
		}

		/**
		 * 面板状态机。刻意不用任何外部状态库：这个面板的生命周期就是「挂载 → 拉两次数据」，
		 * 引入 store 只会让打包与排障更重。
		 */
		function useHub() {
			var stateTuple = react.useState({
				status: "idle",           // idle | loading | ready | down | error
				error: "",
				service: null,            // {ok, health} 或 null
				sources: [],
				counts: null,
				items: [],
				total: 0,
				query: initialQuery(),
				selected: null,
				busy: false,
				toast: "",
				// 全部采集：done/total 用来在按钮上显示进度，busy 期间禁止重复点
				runAll: { busy: false, done: 0, total: 0 },
				// 「每日精选」与「关注偏好」：同一份数据的两个视图，跟条目流并列成三个页签
				tab: "feed",              // feed | digest | prefs
				digests: [],
				digestDetail: null,       // 打开的那一期（含 items）
				prefs: null,              // 服务端已保存的方向（null = 还没加载）
				prefsDraft: [],           // 编辑中的副本
				prefsSavedAt: 0,          // 最近一次保存成功的时间戳（用来显示"已保存"）
			});
			var state = stateTuple[0];
			var setState = stateTuple[1];
			var patch = react.useCallback(function (next) {
				setState(function (prev) { return Object.assign({}, prev, typeof next === "function" ? next(prev) : next); });
			}, []);

			var loadSources = react.useCallback(function () {
				return getJson("/feeds").then(function (data) {
					patch({
						sources: (data && data.items) || [],
						counts: (data && data.counts) || null,
					});
				}).catch(function (err) {
					if (err && err.status === 503) patch({ status: "down", error: (err.payload && err.payload.message) || err.message });
					else patch({ status: "error", error: err.message });
				});
			}, [patch]);

			var loadItems = react.useCallback(function (query) {
				var q = query || state.query;
				var params = [];
				params.push("limit=" + q.limit);
				params.push("offset=" + q.offset);
				if (q.q) params.push("q=" + encodeURIComponent(q.q));
				if (q.sourceId) params.push("source_id=" + encodeURIComponent(q.sourceId));
				if (q.likedOnly) params.push("liked=true");
				return getJson("/items?" + params.join("&")).then(function (data) {
					patch({ items: (data && data.items) || [], total: (data && data.total) || 0, status: "ready" });
				}).catch(function (err) {
					if (err && err.status === 503) patch({ status: "down", error: (err.payload && err.payload.message) || err.message });
					else patch({ status: "error", error: err.message });
				});
			}, [patch, state.query]);

			var loadDigests = react.useCallback(function () {
				return getJson("/digest?limit=30").then(function (data) {
					patch({ digests: (data && data.items) || [] });
				}).catch(function (err) {
					if (err && err.status === 503) patch({ status: "down", error: (err.payload && err.payload.message) || err.message });
					else patch({ error: err.message });
				});
			}, [patch]);

			var loadPreferences = react.useCallback(function () {
				return getJson("/preferences").then(function (data) {
					var directions = (data && data.directions) || [];
					patch({ prefs: directions, prefsDraft: directions.slice() });
				}).catch(function (err) {
					// 偏好是读接口：失败不该让整个面板变红，留空即可（写入时才是真错误）
					patch({ prefs: [], prefsDraft: [], error: err.message });
				});
			}, [patch]);

			var refresh = react.useCallback(function () {
				patch({ status: state.status === "ready" ? "ready" : "loading", error: "" });
				return Promise.all([loadSources(), loadItems(), loadDigests(), loadPreferences()]);
			}, [loadSources, loadItems, loadDigests, loadPreferences, patch, state.status]);

			// 首屏：先看服务活不活，再决定是拉数据还是显示「启动服务」。
			react.useEffect(function () {
				ensureStyle();
				var alive = true;
				getJson("/status").then(function (data) {
					if (!alive) return;
					var service = (data && data.service) || { ok: false };
					patch({ service: service, status: service.ok ? "loading" : "down", error: service.ok ? "" : (service.message || "") });
					if (service.ok) return refresh();
					return undefined;
				}).catch(function (err) {
					if (alive) patch({ status: "error", error: err.message });
				});
				return function () { alive = false; };
			}, []); // 只在挂载时跑一次

			// 搜索/来源/收藏变化：防抖 260ms 再打接口，避免每敲一个字一次请求。
			react.useEffect(function () {
				if (state.status !== "ready") return undefined;
				var timer = setTimeout(function () { loadItems(); }, 260);
				return function () { clearTimeout(timer); };
			}, [state.query.q, state.query.sourceId, state.query.likedOnly, state.query.offset, state.status]);

			// 选中即上报：这是「对话感知当前选中」的另一半，另一半是宿主的 hub_selection 工具。
			react.useEffect(function () {
				var sessionId = (chatBridge.current && chatBridge.current.sessionId) || "";
				var payload = state.selected
					? { sessionId: sessionId, selection: state.selected }
					: { sessionId: sessionId, selection: null };
				sendJson("/selection", "POST", payload).catch(function () { /* 上报失败不影响面板 */ });
			}, [state.selected]);

			var selectItem = react.useCallback(function (item) {
				if (!item) { patch({ selected: null }); return; }
				patch({
					selected: {
						kind: "item",
						id: String(item.id),
						title: item.title || "",
						source_id: item.source_id || "",
						source_name: item.source_name || "",
						url: item.url || "",
						created_at: item.created_at || item.published_at || item.first_seen_at || "",
						summary: oneLine(item.summary || item.body || "", 900),
						liked: Boolean(item.liked),
					},
				});
			}, [patch]);

			var selectSource = react.useCallback(function (source) {
				patch({
					selected: {
						kind: "source",
						id: String(source.id),
						title: source.name || source.id,
						source_id: String(source.id),
						source_name: source.name || "",
						url: source.url || "",
						summary: [source.type, source.item_count !== undefined ? source.item_count + " 条" : "", (source.tags || []).join(" / ")]
							.filter(Boolean).join(" · "),
						liked: false,
					},
				});
			}, [patch]);

			var toggleLike = react.useCallback(function (item) {
				if (!item) return Promise.resolve();
				var itemId = item.id;
				patch({ busy: true });
				var call = item.liked ? sendJson("/items/" + itemId + "/unlike", "POST") : sendJson("/items/" + itemId + "/like", "POST");
				return call.then(function () {
					patch(function (prev) {
						var items = prev.items.map(function (row) {
							return row.id === itemId ? Object.assign({}, row, { liked: !item.liked }) : row;
						});
						var selected = prev.selected && String(prev.selected.id) === String(itemId)
							? Object.assign({}, prev.selected, { liked: !item.liked })
							: prev.selected;
						return { items: items, selected: selected, busy: false };
					});
				}).catch(function (err) {
					patch({ busy: false, toast: err.message });
				});
			}, [patch]);

			var runSource = react.useCallback(function (source) {
				if (!source) return Promise.resolve();
				patch({ busy: true, toast: "" });
				return sendJson("/feeds/" + encodeURIComponent(source.id) + "/run", "POST").then(function (data) {
					var result = (data && data.result) || {};
					patch({ busy: false, toast: fill(zh.runDone, { n: result.new_count !== undefined ? result.new_count : "?" }) });
					return refresh();
				}).catch(function (err) {
					patch({ busy: false, toast: zh.runFailed.replace("{msg}", err.message) });
				});
			}, [patch, refresh]);

			// 全部采集：并发 2 跑所有启用的源。逐个串行会把 10 个源拖到几分钟，
			// 并发太高又容易同时打满上游；2 是折中，进度按完成数实时回显。
			var runAllSources = react.useCallback(function () {
				if (state.runAll && state.runAll.busy) return Promise.resolve();
				var list = (state.sources || []).filter(function (source) { return source.enabled !== false; });
				if (list.length === 0) { patch({ toast: zh.runAllEmpty }); return Promise.resolve(); }
				var total = list.length;
				var cursor = 0;
				var done = 0;
				var okCount = 0;
				var failCount = 0;
				var added = 0;
				patch({ runAll: { busy: true, done: 0, total: total }, toast: "" });
				function step() {
					if (cursor >= total) return Promise.resolve();
					var source = list[cursor];
					cursor += 1;
					return sendJson("/feeds/" + encodeURIComponent(source.id) + "/run", "POST").then(function (data) {
						var result = (data && data.result) || {};
						okCount += 1;
						added += Number(result.new_count) || 0;
					}).catch(function () {
						// 单个源失败不打断整批，最后统一报成功/失败数
						failCount += 1;
					}).then(function () {
						done += 1;
						patch({ runAll: { busy: true, done: done, total: total } });
						return step();
					});
				}
				return Promise.all([step(), step()]).then(function () {
					patch({
						runAll: { busy: false, done: total, total: total },
						toast: failCount
							? fill(zh.runAllFail, { ok: okCount, fail: failCount })
							: fill(zh.runAllDone, { n: added }),
					});
					return refresh();
				});
			}, [patch, refresh, state.runAll, state.sources]);

			// 暂停/恢复：直接打 BFF 的 enable/disable，成功后刷新列表。
			var setSourceEnabled = react.useCallback(function (source, enabled) {
				if (!source) return Promise.resolve();
				patch({ busy: true, toast: "" });
				return sendJson("/feeds/" + encodeURIComponent(source.id) + "/" + (enabled ? "enable" : "disable"), "POST").then(function () {
					patch({ busy: false, toast: enabled ? zh.feedResumed : zh.feedPaused });
					return refresh();
				}).catch(function (err) {
					patch({ busy: false, toast: err.message });
				});
			}, [patch, refresh]);

			// 删除是软删（服务端保留审计痕迹），删完把选中项一起清掉。
			var deleteSource = react.useCallback(function (source) {
				if (!source) return Promise.resolve();
				patch({ busy: true, toast: "" });
				return sendJson("/feeds/" + encodeURIComponent(source.id), "DELETE").then(function () {
					patch({ busy: false, selected: null, toast: zh.feedDeleted });
					return refresh();
				}).catch(function (err) {
					patch({ busy: false, toast: err.message });
				});
			}, [patch, refresh]);

			var startService = react.useCallback(function () {
				patch({ status: "loading", error: "", toast: zh.starting });
				var stopped = false;
				// 首次启动要建 venv、装依赖，/service/start 可能几分钟才返回。
				// 这段时间轮询 /status：引擎一旦能答话就先恢复面板，不必干等那次请求。
				var poll = setInterval(function () {
					if (stopped) { clearInterval(poll); return; }
					getJson("/status").then(function (data) {
						if (stopped) return;
						var service = (data && data.service) || {};
						if (service.ok) {
							stopped = true;
							clearInterval(poll);
							patch({ status: "ready", toast: "" });
							refresh();
						}
					}).catch(function () { /* 还没起来，继续等 */ });
				}, 2000);
				var deadline = setTimeout(function () {
					if (stopped) return;
					stopped = true;
					clearInterval(poll);
				}, 300000);
				var settle = function () { stopped = true; clearInterval(poll); clearTimeout(deadline); };
				return sendJson("/service/start", "POST").then(function (data) {
					settle();
					if (data && data.ok) { patch({ toast: "" }); return refresh(); }
					patch({ status: "down", toast: (data && data.message) || "", error: (data && data.message) || "" });
					return undefined;
				}).catch(function (err) {
					settle();
					patch({ status: "down", error: err.message });
				});
			}, [patch, refresh]);

			var setQuery = react.useCallback(function (next) {
				patch({ query: Object.assign({}, state.query, next) });
			}, [patch, state.query]);

			return {
				state: state,
				patch: patch,
				refresh: refresh,
				selectItem: selectItem,
				selectSource: selectSource,
				toggleLike: toggleLike,
				runSource: runSource,
				runAllSources: runAllSources,
				setSourceEnabled: setSourceEnabled,
				deleteSource: deleteSource,
				startService: startService,
				setQuery: setQuery,
				loadDigests: loadDigests,
				setTab: function (tab) { patch({ tab: tab }); },
				openDigest: function (collection) {
					if (!collection) { patch({ digestDetail: null }); return Promise.resolve(); }
					patch({ busy: true });
					return getJson("/digest/" + encodeURIComponent(collection.id)).then(function (data) {
						patch({ digestDetail: (data && data.collection) || null, busy: false });
					}).catch(function (err) {
						patch({ busy: false, error: err.message });
					});
				},
				addDirection: function (text) {
					var value = String(text || "").trim();
					if (!value) return;
					patch(function (prev) {
						if (prev.prefsDraft.indexOf(value) >= 0) return {};   // 同一方向不必重复
						return { prefsDraft: prev.prefsDraft.concat([value]) };
					});
				},
				removeDirection: function (text) {
					patch(function (prev) {
						return { prefsDraft: prev.prefsDraft.filter(function (item) { return item !== text; }) };
					});
				},
				savePreferences: function () {
					patch({ busy: true });
					// PUT 而不是 POST：语义就是"整份覆盖"，服务端会去空白/去重并回传结果
					return sendJson("/preferences", "PUT", { directions: state.prefsDraft }).then(function (data) {
						var saved = (data && data.directions) || [];
						patch({ prefs: saved, prefsDraft: saved.slice(), busy: false, prefsSavedAt: Date.now() });
					}).catch(function (err) {
						patch({ busy: false, toast: err.message });
					});
				},
			};
		}
		//#endregion

		//#region 组件
		function ServiceDown(props) {
			var t = props.t;
			return jsx.jsxs("div", { className: "mh-empty", children: [
				jsx.jsx("div", { className: "mh-dot off", style: { marginBottom: 10 } }),
				jsx.jsx("h3", { style: { margin: "0 0 6px", fontSize: 14 }, children: t("serviceDown") }),
				jsx.jsx("p", { style: { margin: "0 0 12px" }, children: t("serviceDownHint") }),
				jsx.jsx("button", {
					type: "button",
					className: "mh-btn primary",
					onClick: props.onStart,
					children: props.busy ? t("starting") : t("startService"),
				}),
			] });
		}

		function SourceList(props) {
			var t = props.t;
			var sources = props.sources || [];
			var activeId = props.activeId || "";
			return jsx.jsxs("div", { className: "mh-col", children: [
				jsx.jsx("div", { className: "mh-col-head", children: [
					t("sources"),
					jsx.jsx("span", { className: "mh-spacer" }),
					jsx.jsx("button", {
						type: "button",
						className: "mh-btn sm",
						title: t("runAllTitle"),
						disabled: Boolean(props.runAll && props.runAll.busy) || !props.enabledCount || !props.ready,
						onClick: function () { props.onRunAll(); },
						children: props.runAll && props.runAll.busy ? fill(t("runAllBusy"), props.runAll) : t("runAll"),
					}),
					jsx.jsx("span", { children: intFmt(sources.length) }),
				] }),
				jsx.jsxs("div", { className: "mh-src", children: [
					jsx.jsx("button", {
						type: "button",
						className: "mh-src-item" + (activeId === "" ? " on" : ""),
						onClick: function () { props.onPick(""); },
						children: jsx.jsx("span", { className: "mh-src-name", children: t("allSources") }),
					}),
					sources.map(function (source) {
						var off = source.enabled === false;
						return jsx.jsxs("button", {
							type: "button",
							className: "mh-src-item" + (String(source.id) === String(activeId) ? " on" : ""),
							onClick: function () { props.onPick(String(source.id)); props.onSelectSource(source); },
							children: [
								jsx.jsx("span", { className: "mh-src-name", children: [
									jsx.jsx("span", { className: "mh-dot" + (off || source.status === "error" ? " off" : "") }),
									source.name || source.id,
								] }),
								jsx.jsx("span", { className: "mh-src-meta", children: [
									typeLabel(source.type, t),
									" · ",
									fill(t("itemsCount"), { n: source.item_count || 0 }),
									off ? " · " + t("paused") : "",
								].join("") }),
							],
						}, source.id);
					}),
					sources.length === 0 ? jsx.jsx("div", { className: "mh-note", style: { padding: "8px 4px" }, children: t("noSources") }) : null,
				] }),
			] });
		}

		function ItemList(props) {
			var t = props.t;
			var items = props.items || [];
			var selectedId = props.selectedId || "";
			var query = props.query;
			var total = props.total || 0;
			var pages = Math.max(1, Math.ceil(total / (query.limit || PAGE_SIZE)));
			var page = Math.floor((query.offset || 0) / (query.limit || PAGE_SIZE)) + 1;
			return jsx.jsxs("div", { className: "mh-col", children: [
				jsx.jsx("div", { className: "mh-toolbar", children: [
					jsx.jsx("input", {
						className: "mh-input",
						placeholder: t("search"),
						value: query.q,
						onChange: function (event) { props.onQuery({ q: event.target.value, offset: 0 }); },
					}),
					jsx.jsxs("label", { className: "mh-toggle", children: [
						jsx.jsx("input", {
							type: "checkbox",
							checked: query.likedOnly,
							onChange: function (event) { props.onQuery({ likedOnly: event.target.checked, offset: 0 }); },
						}),
						t("likedOnly"),
					] }),
				] }),
				items.length === 0
					? jsx.jsx("div", { className: "mh-empty", children: t("noItems") })
					: items.map(function (item) {
						var active = String(item.id) === String(selectedId);
						return jsx.jsxs("button", {
							type: "button",
							className: "mh-item" + (active ? " on" : ""),
							onClick: function () { props.onPick(item); },
							children: [
								jsx.jsx("p", { className: "mh-item-title", children: (item.liked ? "★ " : "") + (item.title || "(无标题)") }),
								item.summary ? jsx.jsx("p", { className: "mh-item-sum", children: oneLine(item.summary, 120) }) : null,
								jsx.jsxs("div", { className: "mh-item-meta", children: [
									jsx.jsx("span", { className: "mh-tag", children: item.source_name || item.source_id }),
									jsx.jsx("span", { children: relTime(item.created_at || item.published_at || item.first_seen_at) }),
								] }),
							],
						}, item.id);
					}),
				jsx.jsxs("div", { className: "mh-pager", children: [
					jsx.jsx("span", { children: fill(t("pageInfo"), { page: page, pages: pages, total: total }) }),
					jsx.jsx("span", { className: "mh-spacer" }),
					jsx.jsx("button", {
						type: "button",
						className: "mh-btn",
						disabled: page <= 1,
						onClick: function () { props.onQuery({ offset: Math.max(0, (page - 2) * query.limit) }); },
						children: t("prev"),
					}),
					jsx.jsx("button", {
						type: "button",
						className: "mh-btn",
						disabled: page >= pages,
						onClick: function () { props.onQuery({ offset: page * query.limit }); },
						children: t("next"),
					}),
				] }),
			] });
		}

		function DetailPane(props) {
			var t = props.t;
			var selected = props.selected;
			var item = props.item;
			var source = props.source;
			var toastTuple = react.useState("");
			var toast = toastTuple[0];
			var setToast = toastTuple[1];
			// 删除要按两次：第一次只是把按钮变成「确认删除」，避免误触。
			var confirmTuple = react.useState(false);
			var confirming = confirmTuple[0];
			var setConfirming = confirmTuple[1];
			react.useEffect(function () { setConfirming(false); }, [selected && selected.id]);

			if (!selected) {
				return jsx.jsx("div", { className: "mh-col", children: jsx.jsx("div", { className: "mh-empty", children: t("noSelection") }) });
			}

			var reference = referenceFor(selected);
			function notify(message) { setToast(message); }

			var actions = [
				jsx.jsx("button", {
					type: "button",
					className: "mh-btn primary",
					onClick: function () {
						var written = insertToComposer(reference);
						if (written.ok) { notify(t("inserted")); return; }
						if (written.reason === "rejected" && written.hasBridge) { notify(t("rejected")); return; }
						notify(copyText(reference) ? t("copied") + " · " + t("noSession") : t("noSession"));
					},
					children: t("toChat"),
				}, "chat"),
				jsx.jsx("button", {
					type: "button",
					className: "mh-btn",
					onClick: function () { notify(copyText(reference) ? t("copied") : t("noSession")); },
					children: t("copy"),
				}, "copy"),
			];

			if (selected.kind === "item" && item) {
				actions.push(jsx.jsx("button", {
					type: "button",
					className: "mh-btn",
					disabled: props.busy,
					onClick: function () { props.onToggleLike(item); },
					children: item.liked ? t("unlike") : t("like"),
				}, "like"));
			}
			if (selected.url) {
				actions.push(jsx.jsx("a", {
					className: "mh-btn",
					href: selected.url,
					target: "_blank",
					rel: "noreferrer noopener",
					style: { display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none" },
					children: t("open"),
				}, "open"));
			}
			if (source) {
				actions.push(jsx.jsx("button", {
					type: "button",
					className: "mh-btn",
					disabled: props.busy,
					onClick: function () { props.onRunSource(source).then(function () { notify(t("refresh")); }); },
					children: props.busy ? t("running") : t("runNow"),
				}, "run"));
				actions.push(jsx.jsx("button", {
					type: "button",
					className: "mh-btn",
					disabled: props.busy,
					onClick: function () { props.onToggleSource(source, source.enabled === false); },
					children: source.enabled === false ? t("resumeFeed") : t("pauseFeed"),
				}, "pause"));
				actions.push(jsx.jsx("button", {
					type: "button",
					className: "mh-btn danger" + (confirming ? " armed" : ""),
					disabled: props.busy,
					onClick: function () {
						if (!confirming) { setConfirming(true); return; }
						setConfirming(false);
						props.onDeleteSource(source);
					},
					children: confirming ? t("confirmDeleteFeed") : t("deleteFeed"),
				}, "delete"));
			}

			return jsx.jsxs("div", { className: "mh-col", children: [
				jsx.jsx("div", { className: "mh-col-head", children: t("detail") }),
				jsx.jsxs("div", { className: "mh-detail", children: [
					jsx.jsx("h3", { children: selected.title || "(无标题)" }),
					jsx.jsxs("div", { className: "mh-detail-meta", children: [
						selected.source_name || selected.source_id
							? jsx.jsx("span", { children: t("sourceLabel") + "：" + (selected.source_name || selected.source_id) })
							: null,
						selected.created_at
							? jsx.jsx("span", { children: t("timeLabel") + "：" + relTime(selected.created_at) })
							: null,
						selected.liked ? jsx.jsx("span", { className: "mh-star", children: "★" }) : null,
					] }),
					jsx.jsx("p", { children: selected.summary || (selected.kind === "source" ? t("openInChat") : t("noSummary")) }),
					jsx.jsx("div", { className: "mh-actions", children: actions }),
					jsx.jsx("div", { className: "mh-note", children: t("chatHint") }),
					jsx.jsx("div", { className: "mh-note", children: t("sessionScope") }),
					toast ? jsx.jsx("div", { className: "mh-note", style: { color: "#297a5b" }, children: toast }) : null,
				] }),
			] });
		}

		function TabBar(props) {
			var t = props.t;
			var tabs = [
				{ key: "feed", label: t("tabFeed") },
				{ key: "digest", label: t("tabDigest") },
				{ key: "prefs", label: t("tabPrefs") },
			];
			return jsx.jsx("nav", { className: "mh-tabs", children: tabs.map(function (tab) {
				return jsx.jsx("button", {
					type: "button",
					className: "mh-tab" + (props.active === tab.key ? " on" : ""),
					onClick: function () { props.onSelect(tab.key); },
					children: tab.label,
				}, tab.key);
			}) });
		}

		function kindLabel(kind, t) {
			return kind === "weekly" ? t("digestKindWeekly") : t("digestKindDaily");
		}

		/** 精选条目 → 选中态：字段对齐 selection 白名单，才能被 hub_selection 读到。 */
		function digestItemSelection(item, collection) {
			var summary = [item.rationale ? "入选理由：" + item.rationale : "", item.summary || ""]
				.filter(Boolean).join("\n");
			return {
				kind: "item",
				id: String(item.source_item_id || item.id),
				title: item.title || "",
				source_name: item.source_name || "",
				url: item.url || "",
				created_at: item.created_at || (collection && collection.period_start) || "",
				summary: oneLine(summary, 900),
				liked: false,
			};
		}

		function DigestPane(props) {
			var t = props.t;
			var digests = props.digests || [];
			var detail = props.detail;
			var toastTuple = react.useState("");
			var toast = toastTuple[0];
			var setToast = toastTuple[1];

			return jsx.jsxs("div", { className: "mh-body digest", children: [
				jsx.jsxs("div", { className: "mh-col", children: [
					jsx.jsx("div", { className: "mh-col-head", children: [
						t("digest"),
						jsx.jsx("span", { className: "mh-spacer" }),
						jsx.jsx("span", { children: intFmt(digests.length) }),
					] }),
					digests.length === 0
						? jsx.jsxs("div", { className: "mh-empty", children: [
							jsx.jsx("div", { children: t("digestEmpty") }),
							jsx.jsx("div", { className: "mh-note", style: { marginTop: 8 }, children: t("digestEmptyHint") }),
						] })
						: digests.map(function (collection) {
							var active = detail && String(detail.id) === String(collection.id);
							return jsx.jsxs("button", {
								type: "button",
								className: "mh-digest-item" + (active ? " on" : ""),
								onClick: function () { props.onOpen(collection); },
								children: [
									jsx.jsxs("div", { className: "mh-item-meta", children: [
										jsx.jsx("span", { className: "mh-tag", children: kindLabel(collection.kind, t) }),
										jsx.jsx("span", { children: collection.period_start || "" }),
									] }),
									jsx.jsx("p", { className: "mh-item-title", style: { marginTop: 4 }, children: collection.title || collection.id }),
									collection.summary ? jsx.jsx("p", { className: "mh-item-sum", children: oneLine(collection.summary, 110) }) : null,
								],
							}, collection.id);
						}),
				] }),
				jsx.jsxs("div", { className: "mh-col", children: [
					jsx.jsx("div", { className: "mh-col-head", children: t("detail") }),
					!detail
						? jsx.jsx("div", { className: "mh-empty", children: t("noDigestSelected") })
						: jsx.jsxs("div", { className: "mh-detail", children: [
							jsx.jsx("h3", { children: detail.title || detail.id }),
							jsx.jsxs("div", { className: "mh-detail-meta", children: [
								jsx.jsx("span", { className: "mh-tag", children: kindLabel(detail.kind, t) }),
								jsx.jsx("span", { children: (detail.period_start || "—") + " → " + (detail.period_end || "—") }),
								jsx.jsx("span", { children: fill(t("digestItems"), { n: (detail.items || []).length }) }),
							] }),
							detail.summary ? jsx.jsx("p", { children: detail.summary }) : null,
							(detail.items || []).length === 0
								? jsx.jsx("div", { className: "mh-note", style: { marginTop: 10 }, children: t("digestEmpty") })
								: jsx.jsx("div", { style: { marginTop: 12 }, children: (detail.items || []).map(function (item, index) {
									var selection = digestItemSelection(item, detail);
									return jsx.jsxs("div", {
										className: "mh-digest-item",
										style: { paddingLeft: 0, paddingRight: 0, cursor: "default" },
										children: [
											jsx.jsx("p", { className: "mh-item-title", children: (index + 1) + ". " + (item.title || "(无标题)") }),
											item.rationale ? jsx.jsx("p", { className: "mh-item-sum", children: t("rationale") + "：" + item.rationale }) : null,
											item.summary ? jsx.jsx("p", { className: "mh-item-sum", children: oneLine(item.summary, 240) }) : null,
											jsx.jsxs("div", { className: "mh-actions", style: { margin: "8px 0 0" }, children: [
												jsx.jsx("button", {
													type: "button",
													className: "mh-btn",
													onClick: function () { props.onSelect(selection); },
													children: t("openInChat"),
												}),
												jsx.jsx("button", {
													type: "button",
													className: "mh-btn primary",
													onClick: function () {
														var written = insertToComposer(referenceFor(selection));
														if (written.ok) { setToast(t("inserted")); return; }
														setToast(written.reason === "rejected" ? t("rejected") : t("noSession"));
													},
													children: t("toChat"),
												}),
												item.url ? jsx.jsx("a", {
													className: "mh-btn",
													href: item.url,
													target: "_blank",
													rel: "noreferrer noopener",
													style: { display: "inline-flex", alignItems: "center", textDecoration: "none" },
													children: t("open"),
												}) : null,
											] }),
										],
									}, String(item.id || index));
								}) }),
							toast ? jsx.jsx("div", { className: "mh-note", style: { color: "#297a5b" }, children: toast }) : null,
						] }),
				] }),
			] });
		}

		function PreferencesPane(props) {
			var t = props.t;
			var saved = props.saved || [];
			var draft = props.draft || [];
			var dirty = JSON.stringify(saved) !== JSON.stringify(draft);
			var inputTuple = react.useState("");
			var input = inputTuple[0];
			var setInput = inputTuple[1];

			return jsx.jsxs("div", { className: "mh-col", style: { borderRight: 0 }, children: [
				jsx.jsx("div", { className: "mh-col-head", children: [
					t("prefs"),
					jsx.jsx("span", { className: "mh-spacer" }),
					jsx.jsx("span", { children: dirty ? t("prefsDirty") : (props.savedAt ? t("prefsSaved") : "") }),
				] }),
				jsx.jsxs("div", { className: "mh-prefs", children: [
					jsx.jsx("div", { className: "mh-note", style: { marginBottom: 12 }, children: t("prefsHint") }),
					draft.length === 0 ? jsx.jsx("div", { className: "mh-note", style: { marginBottom: 10 }, children: t("prefsEmpty") }) : null,
					jsx.jsx("div", { className: "mh-chips", style: { padding: "0 0 14px" }, children: draft.map(function (direction) {
						return jsx.jsxs("span", { className: "mh-chip", children: [
							direction,
							jsx.jsx("button", {
								type: "button",
								title: t("prefsRemove"),
								onClick: function () { props.onRemove(direction); },
								children: "×",
							}),
						] }, direction);
					}) }),
					jsx.jsxs("form", {
						className: "mh-row",
						style: { padding: 0 },
						onSubmit: function (event) {
							event.preventDefault();
							if (!input.trim()) return;
							props.onAdd(input);
							setInput("");
						},
						children: [
							jsx.jsx("input", {
								className: "mh-input",
								placeholder: t("prefsPlaceholder"),
								value: input,
								onChange: function (event) { setInput(event.target.value); },
							}),
							jsx.jsx("button", { type: "submit", className: "mh-btn", children: t("prefsAdd") }),
						],
					}),
					jsx.jsx("div", { className: "mh-actions", children: jsx.jsx("button", {
						type: "button",
						className: "mh-btn primary",
						disabled: !dirty || props.busy,
						onClick: props.onSave,
						children: t("prefsSave"),
					}) }),
				] }),
			] });
		}

		function HubPage(props) {
			var t = props.t;
			var hub = props.hub;
			var state = hub.state;
			var activeSource = (state.sources || []).filter(function (source) { return String(source.id) === String(state.query.sourceId); })[0] || null;
			var selectedItem = state.selected && state.selected.kind === "item"
				? (state.items || []).filter(function (item) { return String(item.id) === String(state.selected.id); })[0] || null
				: null;

			if (state.status === "down") {
				return jsx.jsx("div", { className: "mh-root", children: jsx.jsx(ServiceDown, { t: t, busy: state.status === "loading", onStart: hub.startService }) });
			}

			return jsx.jsxs("div", { className: "mh-root", children: [
				jsx.jsxs("header", { className: "mh-header", children: [
					jsx.jsx("span", { className: "mh-dot" + (state.status === "error" ? " off" : "") }),
					jsx.jsx("h2", { className: "mh-title", children: t("title") }),
					jsx.jsx("span", { className: "mh-sub", children: t("subtitle") }),
					jsx.jsx("span", { className: "mh-spacer" }),
					state.counts ? jsx.jsx("span", { className: "mh-sub", children: fill(t("itemsCount"), { n: intFmt(state.total) }) }) : null,
					jsx.jsx("button", { type: "button", className: "mh-btn", onClick: hub.refresh, children: t("refresh") }),
				] }),
				jsx.jsx(TabBar, { t: t, active: state.tab, onSelect: hub.setTab }),
				state.status === "error" ? jsx.jsx("div", { className: "mh-err", children: t("error") + "：" + state.error }) : null,
				state.tab === "digest"
					? jsx.jsx(DigestPane, {
						t: t,
						digests: state.digests,
						detail: state.digestDetail,
						busy: state.busy,
						onOpen: hub.openDigest,
						// 点「引用到对话」= 把它设成选中：右侧详情与 hub_selection 都会看到
						onSelect: function (selection) { hub.patch({ selected: selection }); },
					})
					: state.tab === "prefs"
						? jsx.jsx(PreferencesPane, {
							t: t,
							saved: state.prefs || [],
							draft: state.prefsDraft || [],
							savedAt: state.prefsSavedAt,
							busy: state.busy,
							onAdd: hub.addDirection,
							onRemove: hub.removeDirection,
							onSave: hub.savePreferences,
						})
						: jsx.jsxs("div", { className: "mh-body", children: [
					jsx.jsx(SourceList, {
						t: t,
						sources: state.sources,
						activeId: state.query.sourceId,
						runAll: state.runAll,
						ready: state.status === "ready",
						enabledCount: (state.sources || []).filter(function (source) { return source.enabled !== false; }).length,
						onRunAll: hub.runAllSources,
						onPick: function (id) { hub.setQuery({ sourceId: id, offset: 0 }); },
						onSelectSource: hub.selectSource,
					}),
					jsx.jsx(ItemList, {
						t: t,
						items: state.items,
						total: state.total,
						query: state.query,
						selectedId: state.selected ? state.selected.id : "",
						onPick: function (item) { hub.selectItem(item); },
						onQuery: hub.setQuery,
					}),
					jsx.jsx(DetailPane, {
						t: t,
						selected: state.selected,
						item: selectedItem,
						source: activeSource,
						busy: state.busy,
						onToggleLike: hub.toggleLike,
						onRunSource: hub.runSource,
						onToggleSource: hub.setSourceEnabled,
						onDeleteSource: hub.deleteSource,
					}),
				] }),
				state.toast ? jsx.jsx("div", { className: "mh-toast", children: state.toast }) : null,
			] });
		}

		function MessageHubPanel(props) {
			var localeTuple = props.useLocale ? props.useLocale(NS) : null;
			var translate = localeTuple ? (localeTuple.t || localeTuple) : null;
			function tr(key) {
				if (translate) {
					var value = translate(key);
					if (value !== undefined && value !== null && value !== key) return String(value);
				}
				return zh[key] || key;
			}
			var hub = useHub();
			return jsx.jsx(HubPage, { t: tr, hub: hub });
		}

		function HubIcon(props) {
			var size = props && props.size ? props.size : 16;
			return jsx.jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				"aria-hidden": "true",
				children: [
					jsx.jsx("path", { d: "M2 4.2h12v8.1H6.6L3.4 14.4V4.2Z", strokeLinejoin: "round" }),
					jsx.jsx("path", { d: "M5 7h6M5 9.4h4" , strokeLinecap: "round" }),
				],
			});
		}

		function ChatBridge(props) {
			var p = props || {};
			var sessionId = p.hubSessionId || "";
			var actions = p.hubInputActions || null;
			var notify = p.hubNotify || null;
			react.useEffect(function () {
				chatBridge.current = { sessionId: sessionId, actions: actions, notify: notify };
			}, [sessionId, actions, notify]);
			return null;
		}

		function sessionBridgeInput(ctx, sessionId) {
			var out = { hubSessionId: sessionId, hubInputActions: null, hubNotify: null };
			try {
				var sessions = ctx && typeof ctx.get === "function" ? ctx.get("sessions", false) : null;
				var actx = sessions && typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
				if (actx && typeof actx.get === "function") {
					var conversation = actx.get("conversation", false);
					if (conversation && conversation.input && typeof conversation.input.for === "function") {
						var facade = conversation.input.for(actx);
						if (facade) {
							out.hubInputActions = facade.actions || null;
							if (typeof facade.notify === "function") {
								out.hubNotify = function (level, message) {
									try { facade.notify(level, message); } catch (e) { /* 通知失败无所谓 */ }
								};
							}
						}
					}
				}
			} catch (e) { /* 精简组合里没有会话服务：退回剪贴板 */ }
			return out;
		}
		//#endregion

		//#region 插件体
		var inject = ["slots", "locale", "layout"];

		function apply(ctx) {
			var translate = function (key) {
				try {
					var value = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS)(key) : undefined;
					if (value !== undefined && value !== null && value !== key) return String(value);
				} catch (e) { /* 文案失败不阻塞面板 */ }
				return zh[key] || key;
			};

			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "@dsh-external/dsh-message-hub: dictionaries");

			// 主面板：keyed slot "main"，key 与侧栏入口共用 PANEL_ID。
			ctx.slots.inject("main", function* () {
				yield ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
				}, MessageHubPanel);

				var disposeNav = typeof ctx.reflect !== "undefined" && ctx.reflect && typeof ctx.reflect.provide === "function"
					? ctx.reflect.provide("messageHubNav", {
						open: function () {
							if (ctx.layout && typeof ctx.layout.selectPanel === "function") ctx.layout.selectPanel(PANEL_ID);
						},
					})
					: function () {};
				yield function () { disposeNav(); };
			});

			// 侧栏入口：图标 + 文案。
			ctx.slots.inject("sidebar.panellist", function () {
				return ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 52,
					label: function () { return translate("panel"); },
					locale: NS,
				}, HubIcon);
			});

			// 会话侧的无头桥：主面板没有 session 作用域，靠这个座位拿到草稿写入动作。
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register({
					name: "conversation.input.dock",
					id: "message-hub-chat-bridge",
					order: 62,
					inject: function (sessionId) { return sessionBridgeInput(ctx, sessionId); },
				}, ChatBridge);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		// 纯函数接缝：离线自检直接断言格式化与文案完整性
		exports.__selftest = {
			PANEL_ID: PANEL_ID,
			NS: NS,
			API_PREFIX: API_PREFIX,
			chatBridge: chatBridge,
			insertToComposer: insertToComposer,
			referenceFor: referenceFor,
			oneLine: oneLine,
			relTime: relTime,
			fill: fill,
			intFmt: intFmt,
			typeLabel: typeLabel,
			digestItemSelection: digestItemSelection,
			kindLabel: kindLabel,
			zh: zh,
			en: en,
		};
		return module.exports;
	},
});