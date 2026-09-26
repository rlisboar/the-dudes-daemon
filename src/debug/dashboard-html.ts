/**
 * T-812: página do dashboard de debug (HTML + CSS + JS, sem dependência e sem
 * recurso externo — a CSP só libera o nonce desta resposta).
 *
 * O JS do cliente mora em String.raw: NÃO use crase nem "${" dentro de CSS/JS
 * (o teste t812 garante). Todo texto vindo do daemon (nomes, comandos, logs)
 * entra no DOM por textContent — nunca innerHTML.
 *
 * Gráficos seguem a skill de dataviz: linhas de 2px, grade hairline, legenda
 * para ≥2 séries + rótulo direto no fim quando não colide, crosshair com
 * tooltip, tabela equivalente em cada gráfico, paleta categórica validada
 * (3 primeiros slots, claro/escuro) e cores de status só com ícone + rótulo.
 */

const CSS = String.raw`
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10); --hover: rgba(11,11,11,0.04);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;
  --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b; --good-text: #006300;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.05);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --good-text: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --hover: rgba(255,255,255,0.05);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --good-text: #0ca30c;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--ink); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 5; background: var(--page); border-bottom: 1px solid var(--border); padding: 10px 18px 0; }
.top { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; }
.brand { font-weight: 650; font-size: 15px; }
.who { color: var(--ink-2); }
.spacer { flex: 1; }
.ctl { display: flex; gap: 8px; align-items: center; color: var(--ink-2); }
button, select, input[type=text], input[type=search] {
  font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 10px;
}
button { cursor: pointer; }
button:hover { background: var(--hover); }
button.primary { border-color: var(--s1); }
button:disabled { opacity: .5; cursor: default; }
nav { display: flex; gap: 2px; overflow-x: auto; margin-top: 8px; }
nav button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 7px 12px; color: var(--ink-2); white-space: nowrap; }
nav button.on { color: var(--ink); border-bottom-color: var(--s1); font-weight: 600; }
nav .badge { display: inline-block; min-width: 18px; margin-left: 4px; padding: 0 5px; border-radius: 9px; background: var(--hover); color: var(--ink); font-size: 11px; text-align: center; }
main { padding: 16px 18px 60px; }
section.tab { display: none; }
section.tab.on { display: block; }
h2 { font-size: 14px; margin: 22px 0 8px; font-weight: 650; }
h2:first-child { margin-top: 0; }
h3 { font-size: 13px; margin: 14px 0 6px; font-weight: 600; color: var(--ink-2); }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.kpis { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.tile .label { color: var(--ink-2); font-size: 12px; }
.tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.tile .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.tile svg { display: block; margin-top: 6px; }
.muted { color: var(--muted); }
.ink2 { color: var(--ink-2); }
.mono { font-family: var(--mono); font-size: 12px; }
.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.wrap { white-space: pre-wrap; word-break: break-word; }
.nowrap { white-space: nowrap; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 6px 0 10px; }
.tablebox { overflow-x: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 5px 9px; border-bottom: 1px solid var(--grid); vertical-align: top; text-align: left; }
th { position: sticky; top: 0; background: var(--surface); color: var(--ink-2); font-weight: 600; font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap; }
th.sorted::after { content: " ▾"; }
th.sorted.asc::after { content: " ▴"; }
tr:hover td { background: var(--hover); }
td.cmd { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); white-space: nowrap; font-size: 12px; }
.chip .ic { font-size: 11px; line-height: 1; }
.ic.good { color: var(--good); } .ic.warning { color: var(--warning); } .ic.serious { color: var(--serious); } .ic.critical { color: var(--critical); } .ic.info { color: var(--s1); } .ic.neutral { color: var(--muted); }
.alerts { display: grid; gap: 6px; }
.alert { display: grid; grid-template-columns: 116px 96px 1fr; gap: 10px; align-items: start; background: var(--surface); border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; padding: 8px 12px; }
.alert.crit { border-left-color: var(--critical); } .alert.warn { border-left-color: var(--warning); } .alert.info { border-left-color: var(--s1); }
.alert .t { font-weight: 600; }
.alert .d { color: var(--ink-2); margin-top: 2px; }
.alert .a { margin-top: 4px; }
.alert .a b { font-weight: 600; }
#err { display: none; margin: 10px 18px 0; }
a.btnlink { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; text-decoration: none; }
a.btnlink:hover { background: var(--hover); }
a { color: var(--s1); }
.ok-banner { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--good); border-radius: 8px; padding: 10px 12px; }
.chart { position: relative; }
.chart .head { display: flex; align-items: baseline; gap: 8px; }
.chart .title { font-weight: 600; }
.chart .unit { color: var(--muted); font-size: 12px; }
.chart .tog { margin-left: auto; font-size: 11.5px; padding: 1px 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 4px 0 2px; color: var(--ink-2); font-size: 12px; }
.legend .key { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 5px; border-radius: 1px; }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; box-shadow: 0 4px 16px rgba(0,0,0,.18); font-size: 12px; z-index: 3; min-width: 120px; }
.tip .tt { color: var(--muted); margin-bottom: 3px; }
.tip .tr { display: flex; align-items: center; gap: 6px; }
.tip .tr b { font-variant-numeric: tabular-nums; }
.tip .key { display: inline-block; width: 12px; height: 2px; border-radius: 1px; }
svg text { fill: var(--muted); font-size: 11px; font-family: system-ui, sans-serif; }
svg .end { fill: var(--ink-2); font-size: 11px; }
.meter { position: relative; height: 6px; border-radius: 3px; background: var(--grid); min-width: 60px; }
.meter i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--s1); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; }
.kv .k { color: var(--ink-2); white-space: nowrap; }
.kv .v { font-variant-numeric: tabular-nums; word-break: break-word; }
.agents { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); }
.agent h4 { margin: 0 0 2px; font-size: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.agent .meta { color: var(--ink-2); font-size: 12px; margin-bottom: 8px; }
.logview { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; height: calc(100vh - 230px); min-height: 320px; overflow: auto; font-family: var(--mono); font-size: 12px; padding: 6px 0; }
.logline { display: grid; grid-template-columns: 92px 64px 1fr; gap: 8px; padding: 1px 10px; }
.logline:hover { background: var(--hover); }
.logline .lv { white-space: nowrap; }
.logline .m { white-space: pre-wrap; word-break: break-word; }
.err { color: var(--critical); }
pre.json { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; overflow: auto; max-height: 520px; font-family: var(--mono); font-size: 12px; }
.small { font-size: 12px; }
.pill-row { display: flex; gap: 6px; flex-wrap: wrap; }
.stale { opacity: .55; transition: opacity .2s; }
details summary { cursor: pointer; color: var(--ink-2); }
@media (forced-colors: active) { .legend .key, .tip .key { forced-color-adjust: none; } }
`;

const JS = String.raw`
(function () {
  "use strict";
  var S = {
    tab: "overview", intervalMs: 2000, paused: false, timer: null, busy: false,
    overview: null, series: [], seriesAt: 0, agentsById: {},
    sorts: {}, turnWindow: 60, turnRunner: "", turnAgent: "", eventsAgent: "", eventsKind: "", histWin: "24h",
    logs: { lines: [], lastSeq: 0, es: null, follow: true, level: "", q: "", paused: false },
    lastProfile: null,
  };
  var TABS = [
    ["overview", "Visão geral"], ["agents", "Agentes"], ["turns", "Turnos"], ["history", "Histórico"], ["gate", "Turn-gate"],
    ["procs", "Processos"], ["loop", "Event loop"], ["relay", "Relay MCP"], ["ws", "WebSocket"],
    ["events", "Eventos"], ["logs", "Logs"], ["capture", "Captura CLI"], ["config", "Config"], ["diag", "Diagnóstico"]
  ];

  /* ─────────── utilidades ─────────── */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") el.textContent = String(v);
      else if (k === "cls") el.className = v;
      else if (k === "on") { for (var ev in v) el.addEventListener(ev, v[ev]); }
      else if (k === "title") el.title = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
  function svg(tag, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs || {}) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(id) { return document.getElementById(id); }
  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return "–";
    ms = Number(ms);
    if (ms === 0) return "0ms";
    if (ms < 1) return ms.toFixed(2) + "ms";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    if (ms < 3600000) return (ms / 60000).toFixed(1) + "min";
    if (ms < 86400000) return (ms / 3600000).toFixed(1) + "h";
    return (ms / 86400000).toFixed(1) + "d";
  }
  function fmtAgo(ts) { return ts ? fmtMs(Date.now() - ts) + " atrás" : "–"; }
  function fmtTime(ts) {
    if (!ts) return "–";
    var d = new Date(ts);
    return d.toLocaleTimeString("pt-BR", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }
  function fmtNum(n, dec) {
    if (n == null || !isFinite(n)) return "–";
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(1) + "K";
    return dec != null ? Number(n).toFixed(dec) : String(Math.round(n * 10) / 10);
  }
  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return "–";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function pct(n) { return n == null || !isFinite(n) ? "–" : (Math.round(n * 10) / 10) + "%"; }
  function agentName(id) {
    if (!id) return "–";
    var a = S.agentsById[id];
    return a ? a.name + " · " + id.slice(0, 14) : id;
  }
  function api(path) {
    return fetch(path, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (r.status === 401) throw new Error("401 — token expirado? Reabra a URL do arquivo debug-dashboard.url");
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; });
    });
  }
  function post(path, body) {
    return fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-td-debug": "1" }, body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
  }

  /* ─────────── chips de estado (cor de status sempre com ícone + rótulo) ─────────── */
  var STATE = {
    idle: ["neutral", "●", "ocioso"], thinking: ["info", "▶", "pensando"], speaking: ["info", "▶", "falando"],
    sending: ["info", "▶", "enviando"], stalled: ["warning", "▲", "stalled"], queued: ["neutral", "⏳", "na fila do gate"],
    stopping: ["neutral", "■", "parando"]
  };
  function chip(kind, icon, label, title) {
    return h("span", { cls: "chip", title: title || null }, h("span", { cls: "ic " + kind, text: icon }), label);
  }
  function stateChip(st) { var s = STATE[st] || ["neutral", "●", st || "–"]; return chip(s[0], s[1], s[2]); }
  function endChip(reason) {
    if (reason === "completed") return chip("good", "✓", "completed");
    if (["error", "hard-recover", "process-exit", "spawn-error"].indexOf(reason) >= 0) return chip("critical", "✖", reason);
    if (reason === "retry") return chip("serious", "↻", reason);
    return chip("neutral", "•", reason || "–");
  }
  function levelChip(lv) {
    if (lv === "crit" || lv === "error") return chip("critical", "✖", lv === "crit" ? "CRÍTICO" : "error");
    if (lv === "warn") return chip("warning", "▲", lv === "warn" ? "atenção" : lv);
    return chip("info", "ℹ", "info");
  }
  function priCell(r) {
    if (r.pri == null) return "–";
    if (r.pri <= 4) return chip("critical", "▼", String(r.pri) + " bg");
    if (r.pri < 31) return chip("warning", "▽", String(r.pri));
    return String(r.pri);
  }
  function boolChip(v, yes, no) { return v ? chip("good", "✓", yes || "sim") : chip("neutral", "○", no || "não"); }

  /* ─────────── tabela ordenável ─────────── */
  function table(id, cols, rows, opts) {
    opts = opts || {};
    var st = S.sorts[id] || (opts.sort ? { key: opts.sort, asc: !!opts.asc } : null);
    var data = rows.slice();
    if (st) {
      var col = cols.filter(function (c) { return c.key === st.key; })[0];
      var getv = col && col.sortv ? col.sortv : function (r) { return r[st.key]; };
      data.sort(function (a, b) {
        var x = getv(a), y = getv(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        var c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return st.asc ? c : -c;
      });
    }
    if (opts.limit && data.length > opts.limit) data = data.slice(0, opts.limit);
    var thead = h("tr", null, cols.map(function (c) {
      var cls = (c.num ? "num " : "") + (st && st.key === c.key ? "sorted" + (st.asc ? " asc" : "") : "");
      return h("th", { cls: cls, title: c.help || null, on: { click: function () {
        var cur = S.sorts[id];
        S.sorts[id] = { key: c.key, asc: cur && cur.key === c.key ? !cur.asc : false };
        rerender();
      } } }, c.label);
    }));
    var body = data.map(function (r) {
      return h("tr", null, cols.map(function (c) {
        var v = c.render ? c.render(r) : (c.fmt ? c.fmt(r[c.key], r) : r[c.key]);
        var td = h("td", { cls: (c.num ? "num " : "") + (c.cls || "") });
        if (c.cls === "cmd" && typeof v === "string") td.title = v;
        add(td, v == null ? "–" : v);
        return td;
      }));
    });
    if (body.length === 0) body = [h("tr", null, h("td", { colspan: cols.length, cls: "muted", text: opts.empty || "nada aqui ainda" }))];
    return h("div", { cls: "tablebox" }, h("table", null, h("thead", null, thead), h("tbody", null, body)));
  }

  /* ─────────── gráfico de linha (crosshair + tooltip + tabela) ─────────── */
  var SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)"];
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    var n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return n * p;
  }
  function lineChart(cfg) {
    var card = h("div", { cls: "card chart" });
    var showTable = !!(S.sorts["tbl:" + cfg.id]);
    var tog = h("button", { cls: "tog", text: showTable ? "gráfico" : "tabela", on: { click: function () {
      if (S.sorts["tbl:" + cfg.id]) delete S.sorts["tbl:" + cfg.id]; else S.sorts["tbl:" + cfg.id] = 1;
      rerender();
    } } });
    card.appendChild(h("div", { cls: "head" }, h("span", { cls: "title", text: cfg.title }), h("span", { cls: "unit", text: cfg.unit || "" }), tog));
    var pts = cfg.points || [];
    var series = cfg.series;
    if (series.length > 1) {
      card.appendChild(h("div", { cls: "legend" }, series.map(function (s, i) {
        var key = h("span", { cls: "key" });
        key.style.background = SERIES_COLORS[i];
        return h("span", null, key, s.name);
      })));
    }
    if (showTable) {
      var rows = pts.slice(-60).reverse().map(function (p) {
        var r = { ts: p.ts };
        series.forEach(function (s) { r[s.key] = p[s.key]; });
        return r;
      });
      var cols = [{ key: "ts", label: "hora", fmt: fmtTime }].concat(series.map(function (s) {
        return { key: s.key, label: s.name, num: true, fmt: function (v) { return v == null ? "–" : (cfg.fmt ? cfg.fmt(v) : fmtNum(v)); } };
      }));
      card.appendChild(table("t-" + cfg.id, cols, rows));
      return card;
    }
    S.chartW = S.chartW || {};
    var W = Math.max(260, Math.round(S.chartW[cfg.id] || 520)), H = cfg.height || 150, L = 48, R = 58, T = 10, B = 22;
    var box = h("div", { cls: "plot" });
    card.appendChild(box);
    // Mede depois de entrar no DOM; só redesenha se a largura mudou (sem piscar a cada tick).
    requestAnimationFrame(function () {
      var w = box.clientWidth;
      if (w > 0 && Math.abs(w - W) > 4) { S.chartW[cfg.id] = w; rerender(); }
    });
    if (pts.length < 2) { box.appendChild(h("div", { cls: "muted small", text: "coletando amostras (1 a cada 5s)…" })); return card; }
    var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    var vmax = 0;
    pts.forEach(function (p) { series.forEach(function (s) { var v = p[s.key]; if (v != null && v > vmax) vmax = v; }); });
    var ymax = niceMax(Math.max(vmax, cfg.minMax || 0));
    var x = function (t) { return L + (W - L - R) * (t1 === t0 ? 1 : (t - t0) / (t1 - t0)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / ymax); };
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, tabindex: "0", role: "img", "aria-label": cfg.title });
    var tickFmt = function (v) {
      if (v === 0) return "0";
      if (cfg.fmt === fmtMs) return fmtMs(v);
      var dec = ymax < 1 ? 2 : Number.isInteger(v) ? 0 : 1;
      return Number(v).toFixed(dec) + (cfg.fmt === pct ? "%" : "");
    };
    [0, 0.5, 1].forEach(function (f) {
      var yy = y(ymax * f);
      s.appendChild(svg("line", { x1: L, x2: W - R, y1: yy, y2: yy, stroke: "var(--grid)", "stroke-width": 1 }));
      var lab = svg("text", { x: L - 6, y: yy + 3.5, "text-anchor": "end" });
      lab.textContent = tickFmt(ymax * f);
      s.appendChild(lab);
    });
    s.appendChild(svg("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: "var(--axis)", "stroke-width": 1 }));
    var span = t1 - t0;
    [0, 0.5, 1].forEach(function (f) {
      var tt = t0 + span * f;
      var lab = svg("text", { x: x(tt), y: H - 6, "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle" });
      lab.textContent = new Date(tt).toLocaleTimeString("pt-BR", { hour12: false, hour: "2-digit", minute: "2-digit" });
      s.appendChild(lab);
    });
    var ends = [];
    series.forEach(function (se, i) {
      var d = "";
      var started = false;
      pts.forEach(function (p) {
        var v = p[se.key];
        if (v == null) { started = false; return; }
        d += (started ? "L" : "M") + x(p.ts).toFixed(1) + " " + y(v).toFixed(1);
        started = true;
      });
      if (cfg.area && series.length === 1) {
        var first = pts.filter(function (p) { return p[se.key] != null; });
        if (first.length > 1) {
          var ad = d + "L" + x(first[first.length - 1].ts).toFixed(1) + " " + y(0) + "L" + x(first[0].ts).toFixed(1) + " " + y(0) + "Z";
          s.appendChild(svg("path", { d: ad, fill: SERIES_COLORS[i], "fill-opacity": 0.1, stroke: "none" }));
        }
      }
      s.appendChild(svg("path", { d: d, fill: "none", stroke: SERIES_COLORS[i], "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      for (var j = pts.length - 1; j >= 0; j--) {
        if (pts[j][se.key] != null) { ends.push({ i: i, v: pts[j][se.key], y: y(pts[j][se.key]), x: x(pts[j].ts), name: se.name }); break; }
      }
    });
    ends.forEach(function (e) {
      s.appendChild(svg("circle", { cx: e.x, cy: e.y, r: 4, fill: SERIES_COLORS[e.i], stroke: "var(--surface)", "stroke-width": 2 }));
    });
    var sorted = ends.slice().sort(function (a, b) { return a.y - b.y; });
    var collide = false;
    for (var k = 1; k < sorted.length; k++) if (sorted[k].y - sorted[k - 1].y < 13) collide = true;
    if (!collide) ends.forEach(function (e) {
      var t = svg("text", { x: e.x + 8, y: e.y + 4, "class": "end" });
      t.textContent = cfg.fmt ? cfg.fmt(e.v) : fmtNum(e.v);
      s.appendChild(t);
    });
    var cross = svg("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" });
    s.appendChild(cross);
    var dots = series.map(function (se, i) {
      var c = svg("circle", { r: 4, fill: SERIES_COLORS[i], stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
      s.appendChild(c);
      return c;
    });
    var tip = h("div", { cls: "tip" });
    tip.style.display = "none";
    box.appendChild(s);
    box.appendChild(tip);
    var idx = pts.length - 1;
    function show(i) {
      idx = Math.max(0, Math.min(pts.length - 1, i));
      var p = pts[idx];
      var xx = x(p.ts);
      cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.setAttribute("visibility", "visible");
      clear(tip);
      tip.appendChild(h("div", { cls: "tt", text: fmtTime(p.ts) }));
      series.forEach(function (se, j) {
        var v = p[se.key];
        if (v == null) { dots[j].setAttribute("visibility", "hidden"); return; }
        dots[j].setAttribute("cx", xx); dots[j].setAttribute("cy", y(v)); dots[j].setAttribute("visibility", "visible");
        var key = h("span", { cls: "key" });
        key.style.background = SERIES_COLORS[j];
        tip.appendChild(h("div", { cls: "tr" }, key, h("b", { text: cfg.fmt ? cfg.fmt(v) : fmtNum(v) }), h("span", { cls: "muted", text: se.name })));
      });
      tip.style.display = "block";
      var px = xx;
      tip.style.left = Math.min(W - 170, Math.max(0, px + 12)) + "px";
      tip.style.top = "36px";
    }
    function hide() { cross.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); tip.style.display = "none"; }
    s.addEventListener("pointermove", function (ev) {
      S.hoverUntil = Date.now() + 1500;
      var rect = s.getBoundingClientRect();
      var xv = (ev.clientX - rect.left) * (W / rect.width);
      var tv = t0 + (xv - L) / (W - L - R) * (t1 - t0);
      var best = 0, bd = Infinity;
      for (var q = 0; q < pts.length; q++) { var dd = Math.abs(pts[q].ts - tv); if (dd < bd) { bd = dd; best = q; } }
      show(best);
    });
    s.addEventListener("pointerleave", hide);
    s.addEventListener("focus", function () { show(idx); });
    s.addEventListener("blur", hide);
    s.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowLeft") { show(idx - 1); ev.preventDefault(); }
      if (ev.key === "ArrowRight") { show(idx + 1); ev.preventDefault(); }
    });
    return card;
  }
  function sparkline(values) {
    var W = 120, H = 26;
    var s = svg("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true" });
    var v = values.filter(function (x) { return x != null && isFinite(x); });
    if (v.length < 2) return s;
    var mx = Math.max.apply(null, v) || 1;
    var d = "";
    v.forEach(function (val, i) { d += (i ? "L" : "M") + (i * (W - 6) / (v.length - 1) + 2).toFixed(1) + " " + (H - 3 - (H - 6) * val / mx).toFixed(1); });
    s.appendChild(svg("path", { d: d, fill: "none", stroke: "var(--muted)", "stroke-width": 1.5, "stroke-linejoin": "round" }));
    var lx = W - 4, ly = H - 3 - (H - 6) * v[v.length - 1] / mx;
    s.appendChild(svg("circle", { cx: lx, cy: ly, r: 3, fill: "var(--s1)", stroke: "var(--surface)", "stroke-width": 1.5 }));
    return s;
  }
  function tile(label, value, sub, spark) {
    return h("div", { cls: "card tile" }, h("div", { cls: "label", text: label }), h("div", { cls: "value", text: value }),
      sub ? h("div", { cls: "sub", text: sub }) : null, spark ? sparkline(spark) : null);
  }
  function meter(v, max) {
    var m = h("div", { cls: "meter", title: fmtNum(v) + " / " + fmtNum(max) });
    var i = h("i");
    i.style.width = Math.max(0, Math.min(100, max > 0 ? v / max * 100 : 0)) + "%";
    m.appendChild(i);
    return m;
  }
  function kv(pairs) {
    var box = h("div", { cls: "kv" });
    pairs.forEach(function (p) { if (!p) return; box.appendChild(h("div", { cls: "k", text: p[0] })); var v = h("div", { cls: "v" }); add(v, p[1] == null ? "–" : p[1]); box.appendChild(v); });
    return box;
  }

  /* ─────────── estrutura da página ─────────── */
  var nav = $("nav");
  TABS.forEach(function (t) {
    nav.appendChild(h("button", { id: "nav-" + t[0], on: { click: function () { setTab(t[0]); } } }, t[1], h("span", { cls: "badge", id: "badge-" + t[0] })));
    $("main").appendChild(h("section", { cls: "tab", id: "tab-" + t[0] }));
  });
  function setTab(t) {
    S.tab = t;
    TABS.forEach(function (x) {
      $("nav-" + x[0]).className = x[0] === t ? "on" : "";
      $("tab-" + x[0]).className = "tab" + (x[0] === t ? " on" : "");
    });
    if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
    if (t === "logs") openLogStream(); else closeLogStream();
    tick(true);
  }
  function badge(tab, n) { var b = $("badge-" + tab); if (b) b.textContent = n ? String(n) : ""; }
  var lastRender = null;
  function rerender() { if (lastRender) lastRender(); }

  /* ─────────── Visão geral ─────────── */
  function renderAlerts(alerts) {
    if (!alerts || alerts.length === 0) return h("div", { cls: "ok-banner" }, chip("good", "✓", "tudo nos conformes"), " Nenhum sinal de problema nas heurísticas do daemon.");
    return h("div", { cls: "alerts" }, alerts.map(function (a) {
      return h("div", { cls: "alert " + a.level }, levelChip(a.level),
        h("span", { cls: "ink2" }, a.area, h("div", { cls: "muted small", text: a.when && a.when !== "agora" ? "histórico " + a.when : "agora" })),
        h("div", null, h("div", { cls: "t", text: a.title }), a.detail ? h("div", { cls: "d", text: a.detail }) : null,
          a.action ? h("div", { cls: "a" }, h("b", { text: "Ação: " }), a.action) : null));
    }));
  }
  function seriesOf(key, n) { return S.series.slice(-(n || 12)).map(function (p) { return p[key]; }); }
  function renderOverview() {
    var d = S.overview; if (!d) return;
    var el = clear($("tab-overview"));
    var crit = (d.alerts || []).filter(function (a) { return a.level === "crit"; }).length;
    var warn = (d.alerts || []).filter(function (a) { return a.level === "warn"; }).length;
    badge("overview", crit + warn);
    el.appendChild(h("h2", { text: "Diagnóstico automático" }));
    el.appendChild(renderAlerts(d.alerts));
    el.appendChild(h("h2", { text: "Agora" }));
    var loop = d.loop || { window: {}, total: {} };
    var g = d.gate.pools.main, bg = d.gate.pools.bg;
    var hm = d.system.hostMemory || {};
    var agentsWithTurn = d.agents.filter(function (a) { return a.runner && a.runner.inTurn; }).length;
    el.appendChild(h("div", { cls: "kpis" },
      tile("Agentes", String(d.agents.length), agentsWithTurn + " em turno · " + d.agents.filter(function (a) { return a.hasRunner; }).length + " com runner"),
      tile("Turn-gate main", g.active + "/" + g.max, g.queued + " na fila · bg " + bg.active + "/" + bg.max + (bg.queued ? " (+" + bg.queued + ")" : ""), seriesOf("gateActive")),
      tile("Event loop p99", fmtMs(loop.window.p99), "máx " + fmtMs(loop.window.max) + " · ELU " + pct(loop.eluPct), seriesOf("elP99")),
      tile("Travamentos (5 min)", String(d.stalls5m), "≥150ms com o loop parado", seriesOf("stalls")),
      tile("CPU do daemon", pct(d.process.cpuPct), "user " + d.process.resourceUsage.userCpuS + "s · sys " + d.process.resourceUsage.systemCpuS + "s", seriesOf("cpuPct")),
      tile("Memória do daemon", fmtNum(d.process.memory.rssMb) + " MB", "heap " + fmtNum(d.process.memory.heapUsedMb) + " MB (" + pct(d.process.heap.usedPct) + " do limite)", seriesOf("rssMb")),
      tile("Processos filhos", d.procs ? String(d.procs.totals.count) : "–", d.procs ? "CPU " + pct(d.procs.totals.cpuPct) + " · " + fmtNum(d.procs.totals.rssMb) + " MB" : "amostrando…", seriesOf("childCpuPct")),
      tile("WS orchestrator", d.ws.readyState === 1 ? "aberto" : "FECHADO", "RTT p50 " + fmtMs(d.ws.rtt && d.ws.rtt.p50) + " · quedas " + d.ws.disconnects),
      tile("Prioridade do daemon", d.procs && d.procs.self ? "pri " + d.procs.self.pri : "–",
        (d.procs && d.procs.self && d.procs.self.pri <= 4 ? "BACKGROUND (estrangulado) · " : "") + (d.procs && d.procs.priCounts ? "filhos por pri: " + Object.keys(d.procs.priCounts).map(function (k) { return k + "→" + d.procs.priCounts[k]; }).join(" · ") : "") + " · terminal = 31"),
      tile("Host", "load " + (d.system.load[0]), d.system.cpus + " CPUs · memória livre " + (hm.freePct != null ? hm.freePct + "%" : fmtNum(d.system.freeMemMb) + " MB") + (hm.swapUsedMb != null ? " · swap " + hm.swapUsedMb + "/" + hm.swapTotalMb + " MB" : ""), seriesOf("load1")),
      tile("Logs", fmtNum(d.logs.error) + " erros", fmtNum(d.logs.warn) + " avisos · " + fmtNum(d.logs.info) + " info")
    ));
    el.appendChild(h("h2", { text: "Agentes" }));
    el.appendChild(agentsTable(d.agents));
    el.appendChild(h("h2", { text: "Tendências (última hora)" }));
    var P = S.series.slice(-720);
    el.appendChild(h("div", { cls: "grid" },
      lineChart({ id: "el", title: "Atraso do event loop", unit: "ms", points: P, fmt: fmtMs, series: [{ key: "elP50", name: "p50" }, { key: "elP99", name: "p99" }, { key: "elMax", name: "máx" }] }),
      lineChart({ id: "gate", title: "Turnos no pool main", unit: "turnos", points: P, series: [{ key: "gateActive", name: "rodando" }, { key: "gateQueued", name: "na fila" }] }),
      lineChart({ id: "cpu", title: "CPU do processo do daemon", unit: "% de 1 núcleo", points: P, area: true, fmt: pct, series: [{ key: "cpuPct", name: "CPU" }] }),
      lineChart({ id: "ccpu", title: "CPU somada dos processos filhos", unit: "% de 1 núcleo", points: P, area: true, fmt: pct, series: [{ key: "childCpuPct", name: "CPU filhos" }] }),
      lineChart({ id: "sync", title: "Tempo bloqueado em chamadas síncronas", unit: "ms por amostra de 5s", points: P, area: true, fmt: fmtMs, series: [{ key: "syncMs", name: "bloqueado" }] }),
      lineChart({ id: "mem", title: "Memória do daemon", unit: "MB", points: P, series: [{ key: "rssMb", name: "RSS" }, { key: "heapUsedMb", name: "heap usado" }] }),
      lineChart({ id: "load", title: "Load do host (1 min)", unit: "processos", points: P, area: true, series: [{ key: "load1", name: "load" }] }),
      lineChart({ id: "relay", title: "Chamadas MCP pelo relay", unit: "por 5s", points: P, area: true, series: [{ key: "relayReqs", name: "requisições" }] })
    ));
  }
  function agentsTable(agents) {
    return table("agents-summary", [
      { key: "name", label: "agente", render: function (a) { return h("span", { title: a.agentId }, a.name, a.ephemeral ? h("span", { cls: "muted", text: " (efêmero)" }) : null); } },
      { key: "cliRunner", label: "runner", render: function (a) { return a.cliRunner + (a.model ? " · " + a.model : ""); } },
      { key: "state", label: "estado", sortv: function (a) { return a.runner && (a.runner.longTurn ? "turno longo" : a.runner.state); }, render: function (a) {
        if (!a.runner) return chip("neutral", "○", "sem runner");
        if (a.runner.longTurn) return chip("warning", "▶", "turno longo", (a.runner.turnHoldReason || "result não chegou") + " · " + fmtMs(a.runner.turnElapsedMs));
        return stateChip(a.runner.state);
      } },
      { key: "phase", label: "fase do turno", sortv: function (a) { return a.runner && a.runner.currentTurn && a.runner.currentTurn.phase; }, render: function (a) { var t = a.runner && a.runner.currentTurn; return t && t.phase !== "ended" ? t.phase + " · " + fmtMs(t.sinceStartMs != null ? t.sinceStartMs : t.sinceEnqueueMs) : "–"; } },
      { key: "idle", label: "sem atividade", num: true, sortv: function (a) { return a.runner && a.runner.inTurn ? a.runner.idleMs : null; }, render: function (a) { return a.runner && a.runner.inTurn ? fmtMs(a.runner.idleMs) : "–"; }, help: "tempo desde o último evento semântico (só em turno)" },
      { key: "queued", label: "fila", num: true, sortv: function (a) { return a.runner ? (a.runner.queued + a.runner.pendingMessages + a.runner.claudeWriteQueue) : null; }, render: function (a) { return a.runner ? String(a.runner.queued + a.runner.pendingMessages + a.runner.claudeWriteQueue) : "–"; } },
      { key: "tools", label: "tools", num: true, sortv: function (a) { return a.runner && a.runner.toolsInFlight; }, render: function (a) { return a.runner && a.runner.toolsInFlight ? a.runner.toolsInFlight + " · " + fmtMs(a.runner.toolsInFlightMs) : "0"; } },
      { key: "cpu", label: "CPU", num: true, sortv: function (a) { return a.procs && a.procs.cpuPct; }, render: function (a) { return a.procs ? pct(a.procs.cpuPct) : "–"; }, help: "CPU somada da árvore de processos do agente" },
      { key: "rss", label: "RSS", num: true, sortv: function (a) { return a.procs && a.procs.rssMb; }, render: function (a) { return a.procs ? a.procs.rssMb + " MB" : "–"; } },
      { key: "t1h", label: "turnos 1h", num: true, sortv: function (a) { return a.turns1h && a.turns1h.count; }, render: function (a) { return a.turns1h ? a.turns1h.completed + "/" + a.turns1h.count : "–"; }, help: "completados / total na última hora" },
      { key: "p50", label: "duração p50", num: true, sortv: function (a) { return a.turns1h && a.turns1h.duration.p50; }, render: function (a) { return a.turns1h ? fmtMs(a.turns1h.duration.p50) : "–"; } },
      { key: "fe", label: "1º evento p50", num: true, sortv: function (a) { return a.turns1h && a.turns1h.firstEvent.p50; }, render: function (a) { return a.turns1h ? fmtMs(a.turns1h.firstEvent.p50) : "–"; } },
      { key: "hr", label: "hard 1h", num: true, sortv: function (a) { return a.runner && a.runner.hardRecoversLastHour; }, render: function (a) { return a.runner ? String(a.runner.hardRecoversLastHour) : "–"; } },
      { key: "out", label: "último stdout", num: true, sortv: function (a) { return a.io && a.io.lastStdoutAt; }, render: function (a) { return a.io && a.io.lastStdoutAt ? fmtAgo(a.io.lastStdoutAt) : "–"; } },
      { key: "ctx", label: "contexto", sortv: function (a) { return a.runner && a.runner.contextLimit ? a.runner.contextUsed / a.runner.contextLimit : null; }, render: function (a) { return a.runner && a.runner.contextLimit ? h("div", { title: fmtNum(a.runner.contextUsed) + " / " + fmtNum(a.runner.contextLimit) + " tokens" }, meter(a.runner.contextUsed, a.runner.contextLimit)) : "–"; } }
    ], agents, { sort: "idle" });
  }

  /* ─────────── Agentes ─────────── */
  function renderAgents() {
    var d = S.overview; if (!d) return;
    var el = clear($("tab-agents"));
    badge("agents", d.agents.length);
    if (d.agents.length === 0) { el.appendChild(h("div", { cls: "muted", text: "Nenhum agente neste daemon." })); }
    el.appendChild(h("h2", { text: "Turnos em voo (" + d.liveTurns.length + ")" }));
    el.appendChild(liveTurnsTable(d.liveTurns));
    el.appendChild(h("h2", { text: "Agentes (" + d.agents.length + ")" }));
    var box = h("div", { cls: "agents" });
    d.agents.forEach(function (a) {
      var r = a.runner || {};
      var th = r.thresholds || {};
      var ct = r.currentTurn;
      box.appendChild(h("div", { cls: "card agent" },
        h("h4", null, a.name, a.runner ? (r.longTurn ? chip("warning", "▶", "turno longo", r.turnHoldReason || "") : stateChip(r.state)) : chip("neutral", "○", "sem runner"), a.ephemeral ? chip("neutral", "◌", "efêmero") : null),
        h("div", { cls: "meta", text: a.agentId + " · " + a.cliRunner + (a.model ? " · " + a.model : "") + (a.effort ? " · effort " + a.effort : "") + (a.projectId ? " · proj " + a.projectId : "") }),
        kv([
          ["turno", ct && ct.phase !== "ended" ? ct.phase + " · desde início " + fmtMs(ct.sinceStartMs) + " · gate " + fmtMs(ct.gateWaitMs) + " · 1º evento " + fmtMs(ct.firstEventMs) + (ct.attempt ? " · tentativa " + ct.attempt : "") : (r.inTurn ? "em turno (sem timing)" : "sem turno")],
          ["atividade", "última há " + fmtMs(r.idleMs) + " · turno há " + fmtMs(r.turnElapsedMs) + (r.longTurn ? " · TURNO LONGO (" + (r.turnHoldReason || "result não chegou") + ")" : "") + (r.softReported ? " · SOFT reportado" : "") + (r.deadMs != null ? " · processo morto há " + fmtMs(r.deadMs) : "")],
          ["limiares", "soft " + fmtMs(th.softMs) + " · hard " + fmtMs(th.hardMs) + " · 1º evento " + fmtMs(th.firstEventMs) + " · pós-evento " + fmtMs(th.postEventMs) + " · tools " + fmtMs(th.toolsHardMs) + (th.lifetimeMs ? " · lifetime " + fmtMs(th.lifetimeMs) : "") + (th.lifetimeCapMs ? " · cap " + fmtMs(th.lifetimeCapMs) : "")],
          ["fila", "per-message " + (r.queued || 0) + " · restart " + (r.pendingMessages || 0) + " · stdin claude " + (r.claudeWriteQueue || 0) + (r.claudeInflight ? " · 1 em voo" : "") + (r.claudeUnacceptedMs != null ? " · NÃO aceita há " + fmtMs(r.claudeUnacceptedMs) : "") + " · buffer host " + a.inboundBuffered],
          ["flags", h("span", { cls: "pill-row" }, boolChip(r.busy, "busy", "livre"), boolChip(r.waitingTurnGate, "esperando gate", "fora do gate"), boolChip(r.holdsGateSlot, "segura slot", "sem slot"), r.compacting ? chip("warning", "▲", "compact " + fmtMs(r.compactingMs)) : null, r.recoveringHung ? chip("serious", "↻", "recuperando") : null, r.restarting ? chip("serious", "↻", "reiniciando") : null, r.clearing ? chip("neutral", "•", "clear") : null)],
          ["tools em voo", (r.toolsInFlight || 0) + (r.toolsInFlightMs != null ? " há " + fmtMs(r.toolsInFlightMs) : "") + (r.ocToolParts ? " · parts opencode " + r.ocToolParts : "") + (r.ocPendingPermissions ? " · permissões pendentes " + r.ocPendingPermissions : "")],
          ["processos", "proc " + (r.procPid || "–") + (r.procPid ? (r.procAlive ? " vivo" : " MORTO") : "") + " · turno " + (r.turnProcPid || "–") + (r.turnProcPid ? (r.turnProcAlive ? " vivo" : " MORTO") : "") + " · one-shot " + (r.oneShotPid || "–") + " · rastreados [" + (r.liveTurnPids || []).join(", ") + "]" + (a.procs ? " · árvore " + a.procs.procs + " procs, CPU " + pct(a.procs.cpuPct) + ", " + a.procs.rssMb + " MB" : "")],
          ["recover", "hard 1h: " + (r.hardRecoversLastHour || 0) + " · nudges: " + (r.hangNudgesUsed || 0) + (r.nudgeScheduled ? " (agendado)" : "") + (r.inflightAttempt != null ? " · tentativa em voo " + r.inflightAttempt : "")],
          ["sessão", (r.sessionId || "–") + " · epoch " + r.epoch + (r.firstTurn ? " · 1º turno" : "") + (r.opencodeServe ? " · serve " + (r.opencodeServe.ready ? "pronto " + r.opencodeServe.url : "NÃO pronto") : "") + (r.dshAlive != null ? " · dsh " + (r.dshAlive ? "vivo" : "MORTO") : "")],
          ["contexto", r.contextLimit ? h("span", null, fmtNum(r.contextUsed) + " / " + fmtNum(r.contextLimit) + " (" + pct(r.contextUsed / r.contextLimit * 100) + ")") : fmtNum(r.contextUsed) + " (janela desconhecida)"],
          ["I/O do CLI", a.io ? "stdout " + fmtBytes(a.io.stdoutBytes) + " em " + a.io.stdoutChunks + " chunks (último " + fmtAgo(a.io.lastStdoutAt) + ") · stderr " + fmtBytes(a.io.stderrBytes) + " (último " + fmtAgo(a.io.lastStderrAt) + ") · entrada " + fmtBytes(a.io.stdinBytes) + " (" + (a.io.stdinWrites + a.io.argvCount) + "×)" : "–"],
          ["turnos 1h", a.turns1h ? a.turns1h.completed + "/" + a.turns1h.count + " ok · duração p50 " + fmtMs(a.turns1h.duration.p50) + " p95 " + fmtMs(a.turns1h.duration.p95) + " · 1º evento p50 " + fmtMs(a.turns1h.firstEvent.p50) + " · gate p95 " + fmtMs(a.turns1h.gateWait.p95) : "nenhum"],
          ["tempo por estado", a.stateInfo ? Object.keys(a.stateInfo.timeByState).map(function (k) { return k + " " + fmtMs(a.stateInfo.timeByState[k]); }).join(" · ") : "–"],
          ["task ativa", r.activeTaskId || "–"],
          ["workspace", h("span", { cls: "mono", text: r.workspace || "–" })],
          ["worktree", a.worktree ? h("span", { cls: "mono", text: a.worktree }) : "–"]
        ]),
        h("div", { cls: "row" },
          h("button", { text: "logs deste agente", on: { click: function () { S.logs.q = a.agentId; setTab("logs"); } } }),
          h("button", { text: "turnos", on: { click: function () { S.turnAgent = a.agentId; setTab("turns"); } } }),
          h("button", { text: "eventos", on: { click: function () { S.eventsAgent = a.agentId; setTab("events"); } } }))
      ));
    });
    el.appendChild(box);
    el.appendChild(h("h2", { text: "Estado do host de agentes" }));
    el.appendChild(h("pre", { cls: "json", text: JSON.stringify(d.host, null, 2) }));
  }
  function liveTurnsTable(list) {
    return table("live-turns", [
      { key: "agentId", label: "agente", fmt: function (v) { return agentName(v); } },
      { key: "runner", label: "runner" },
      { key: "phase", label: "fase" },
      { key: "sinceEnqueueMs", label: "desde enfileirar", num: true, fmt: fmtMs },
      { key: "sinceStartMs", label: "desde início", num: true, fmt: fmtMs },
      { key: "gateWaitMs", label: "espera gate", num: true, fmt: fmtMs },
      { key: "firstEventMs", label: "1º evento", num: true, fmt: fmtMs },
      { key: "firstEventKind", label: "tipo" },
      { key: "bootMs", label: "boot", num: true, fmt: fmtMs },
      { key: "attempt", label: "tentativa", num: true },
      { key: "sessionMode", label: "sessão" }
    ], list, { sort: "sinceEnqueueMs", empty: "nenhum turno em voo" });
  }

  /* ─────────── Turnos ─────────── */
  function distCols(prefix, label) {
    return [
      { key: prefix + "50", label: label + " p50", num: true, sortv: function (r) { return r[prefix].p50; }, render: function (r) { return fmtMs(r[prefix].p50); } },
      { key: prefix + "95", label: "p95", num: true, sortv: function (r) { return r[prefix].p95; }, render: function (r) { return fmtMs(r[prefix].p95); } },
      { key: prefix + "mx", label: "máx", num: true, sortv: function (r) { return r[prefix].max; }, render: function (r) { return fmtMs(r[prefix].max); } }
    ];
  }
  function aggTable(id, rows, keyLabel, keyFmt) {
    var maxP95 = rows.reduce(function (m, r) { return Math.max(m, r.duration.p95 || 0); }, 0);
    return table(id, [
      { key: "key", label: keyLabel, fmt: keyFmt || null },
      { key: "count", label: "turnos", num: true },
      { key: "completed", label: "ok", num: true },
      { key: "problems", label: "problemas", num: true },
      { key: "reasons", label: "motivos de fim", sortv: function (r) { return r.problems; }, render: function (r) { return h("span", { cls: "pill-row" }, Object.keys(r.endReasons).map(function (k) { return h("span", null, endChip(k), " " + r.endReasons[k]); })); } },
      { key: "bar", label: "duração p50 → p95", sortv: function (r) { return r.duration.p95; }, render: function (r) { return h("div", { title: "p50 " + fmtMs(r.duration.p50) + " · p95 " + fmtMs(r.duration.p95) }, meter(r.duration.p95 || 0, maxP95)); } }
    ].concat(distCols("duration", "duração"), distCols("firstEvent", "1º evento"), distCols("gateWait", "gate"), [
      { key: "queue", label: "fila p50", num: true, sortv: function (r) { return r.queue.p50; }, render: function (r) { return fmtMs(r.queue.p50); } },
      { key: "boot", label: "boot p50", num: true, sortv: function (r) { return r.boot.p50; }, render: function (r) { return fmtMs(r.boot.p50); } },
      { key: "lastTs", label: "último", num: true, fmt: fmtAgo }
    ]), rows, { sort: "count" });
  }
  function renderTurns(d) {
    var el = clear($("tab-turns"));
    badge("turns", d.live.length || "");
    var sel = h("select", { on: { change: function (e) { S.turnWindow = Number(e.target.value); tick(true); } } },
      [[15, "15 min"], [60, "1 hora"], [360, "6 horas"], [1440, "24 horas"]].map(function (o) { return h("option", { value: o[0], selected: S.turnWindow === o[0] }, o[1]); }));
    var runners = {};
    d.recent.forEach(function (t) { runners[t.runner] = 1; });
    var rsel = h("select", { on: { change: function (e) { S.turnRunner = e.target.value; tick(true); } } },
      [h("option", { value: "" }, "todos os runners")].concat(Object.keys(runners).sort().map(function (r) { return h("option", { value: r, selected: S.turnRunner === r }, r); })));
    el.appendChild(h("div", { cls: "row" }, "janela dos agregados:", sel, "runner:", rsel,
      S.turnAgent ? h("button", { text: "agente: " + agentName(S.turnAgent) + " ✕", on: { click: function () { S.turnAgent = ""; tick(true); } } }) : null,
      h("span", { cls: "muted", text: "Registro estruturado do [turn-latency]: queue = enfileirar→início · gate = espera de slot · 1º evento = início→1ª saída semântica · boot = arranque do CLI." })));
    el.appendChild(h("h2", { text: "Por runner" }));
    el.appendChild(aggTable("agg-runner", d.byRunner, "runner"));
    el.appendChild(h("h2", { text: "Por agente" }));
    el.appendChild(aggTable("agg-agent", d.byAgent, "agente", function (v) { return agentName(v); }));
    el.appendChild(h("h2", { text: "Em voo (" + d.live.length + ")" }));
    el.appendChild(liveTurnsTable(d.live));
    el.appendChild(h("h2", { text: "Turnos recentes (" + d.recent.length + ")" }));
    el.appendChild(table("recent-turns", [
      { key: "ts", label: "fim", fmt: fmtTime },
      { key: "agentId", label: "agente", fmt: function (v) { return agentName(v); } },
      { key: "runner", label: "runner" },
      { key: "endReason", label: "fim", render: function (r) { return endChip(r.endReason); } },
      { key: "durationMs", label: "duração", num: true, fmt: fmtMs },
      { key: "firstEventMs", label: "1º evento", num: true, fmt: fmtMs },
      { key: "gateWaitMs", label: "gate", num: true, fmt: fmtMs },
      { key: "queueMs", label: "fila", num: true, fmt: fmtMs },
      { key: "bootMs", label: "boot", num: true, fmt: fmtMs },
      { key: "acceptMs", label: "aceite", num: true, fmt: fmtMs },
      { key: "firstEventKind", label: "1º tipo" },
      { key: "killedBy", label: "morto por" },
      { key: "recoverKind", label: "recover" },
      { key: "lifetimeLimit", label: "teto" },
      { key: "attempt", label: "tent.", num: true },
      { key: "sessionMode", label: "sessão" }
    ], d.recent.slice().reverse(), { sort: "ts", limit: 800 }));
  }

  /* ─────────── Histórico (logs do perfil) ─────────── */
  function histAggTable(id, rows, keyLabel) {
    return table(id, [
      { key: "key", label: keyLabel },
      { key: "count", label: "turnos", num: true },
      { key: "okPct", label: "ok %", num: true, render: function (r) { return r.okPct < 70 ? chip("critical", "✖", pct(r.okPct)) : r.okPct < 90 ? chip("warning", "▲", pct(r.okPct)) : pct(r.okPct); }, help: "completados / (completados + falhas); stop/reset não contam" },
      { key: "failures", label: "falhas", num: true },
      { key: "reasons", label: "motivos de fim", sortv: function (r) { return r.problems; }, render: function (r) { return h("span", { cls: "pill-row" }, Object.keys(r.endReasons).filter(function (k) { return k !== "completed"; }).map(function (k) { return h("span", null, endChip(k), " " + r.endReasons[k]); })); } }
    ].concat(distCols("duration", "duração"), distCols("firstEvent", "1º evento"), [
      { key: "q95", label: "fila p95", num: true, sortv: function (r) { return r.queue.p95; }, render: function (r) { return fmtMs(r.queue.p95); } },
      { key: "queueWait10m", label: "≥10min na fila", num: true },
      { key: "retries", label: "retries", num: true },
      { key: "recent", label: "últimas 3h", num: true, sortv: function (r) { return r.recent3h.count; }, render: function (r) { return r.recent3h.count ? r.recent3h.completed + "/" + r.recent3h.count : "–"; } },
      { key: "lastProblemTs", label: "última falha", num: true, fmt: fmtAgo }
    ]), rows, { sort: "count" });
  }
  function renderHistory(d) {
    var el = clear($("tab-history"));
    var hs = d.history;
    var btn = h("button", { cls: "primary", text: d.running ? "analisando…" : "reanalisar agora", on: { click: function () {
      btn.disabled = true; btn.textContent = "analisando…";
      post("/api/history/refresh").then(function () { tick(true); }).catch(showError);
    } } });
    if (d.running) btn.disabled = true;
    var win = h("select", { on: { change: function (e) { S.histWin = e.target.value; rerender(); } } }, [["24h", "últimas 24h"], ["7d", "últimos 7 dias"]].map(function (o) { return h("option", { value: o[0], selected: S.histWin === o[0] }, o[1]); }));
    el.appendChild(h("p", { cls: "muted", text: "O que está em memória zera a cada restart do daemon; esta aba lê o log do perfil (daemon-prod.log e rotações) e resume 24h e 7 dias: turnos de todos os runners, hangs, filas estouradas, reinícios e erros. Recalcula a cada 10 min." }));
    if (!hs) { el.appendChild(h("div", { cls: "row" }, btn, h("span", { cls: "muted", text: d.running ? "primeira análise em andamento…" : "ainda não analisado (roda 20s após o boot)" }))); return; }
    el.appendChild(h("div", { cls: "row" }, btn, "janela:", win, h("span", { cls: "muted", text: "analisado " + fmtAgo(hs.generatedAt) + " em " + fmtMs(hs.tookMs) + " · " + hs.files.map(function (f) { return f.path.split("/").pop() + " (" + fmtBytes(f.bytes) + ")"; }).join(", ") + (hs.error ? " · ERRO: " + hs.error : "") })));
    var w = hs.windows[S.histWin];
    el.appendChild(h("div", { cls: "kpis" },
      tile("Turnos", fmtNum(w.turns), S.histWin === "24h" ? "no último dia" : "nos últimos 7 dias"),
      tile("Esperaram ≥10min na fila", fmtNum(w.queueWait10m), "fila do próprio agente"),
      tile("Descartadas por fila cheia", fmtNum(w.queueFullDrops.reduce(function (a, x) { return a + x.n; }, 0)), w.queueFullDrops.slice(0, 3).map(function (x) { return x.agent + " " + x.n; }).join(" · ") || "nenhuma"),
      tile("Re-execs (self-update)", fmtNum(w.reexecs), w.releases + " troca(s) de release"),
      tile("Hard recovers", fmtNum(w.hardRecoversByAgent.reduce(function (a, x) { return a + x.n; }, 0)), w.hardRecoversByAgent.slice(0, 3).map(function (x) { return x.agent + " " + x.n; }).join(" · ") || "nenhum"),
      tile("Stdin não aceito (claude)", fmtNum(w.stdinNotAccepted), "watchdog T-758"),
      tile("Estado perdido no WS", fmtNum(w.stateLost), "running/state/usage/context"),
      tile("Handshake falho", fmtNum(w.wsHandshakeFailures), "orchestrator fora")));
    el.appendChild(h("h2", { text: "Por runner" }));
    el.appendChild(histAggTable("h-runner", w.byRunner, "runner"));
    el.appendChild(h("h2", { text: "Por agente" }));
    el.appendChild(histAggTable("h-agent", w.byAgent, "agente (runner)"));
    el.appendChild(h("h2", { text: "Re-execs por dia (self-update)" }));
    el.appendChild(table("h-reexec", [{ key: "d", label: "dia (UTC)" }, { key: "n", label: "re-execs", num: true }], Object.keys(hs.reexecsByDay).map(function (k) { return { d: k, n: hs.reexecsByDay[k] }; }), { sort: "d" }));
    el.appendChild(h("div", { cls: "grid" },
      h("div", null, h("h3", { text: "Hard recovers (agente · runner · motivo)" }), table("h-hard", [{ key: "agent", label: "agente" }, { key: "runner", label: "runner" }, { key: "reason", label: "motivo" }, { key: "n", label: "vezes", num: true }], w.hardRecovers, { sort: "n", empty: "nenhum" })),
      h("div", null, h("h3", { text: "Soft hangs (stalled)" }), table("h-soft", [{ key: "agent", label: "agente" }, { key: "runner", label: "runner" }, { key: "n", label: "vezes", num: true }], w.softHangs, { sort: "n", empty: "nenhum" })),
      h("div", null, h("h3", { text: "Mensagens descartadas por fila cheia" }), table("h-drops", [{ key: "agent", label: "agente" }, { key: "n", label: "descartadas", num: true }], w.queueFullDrops, { sort: "n", empty: "nenhuma" }))));
    el.appendChild(h("h2", { text: "Padrões conhecidos" }));
    el.appendChild(table("h-pat", [{ key: "id", label: "padrão" }, { key: "n", label: "vezes", num: true }, { key: "last", label: "última", num: true, fmt: fmtAgo }, { key: "sample", label: "exemplo", cls: "cmd" }], w.patterns, { sort: "n", empty: "nenhum" }));
    el.appendChild(h("h2", { text: "Avisos e erros mais frequentes (normalizados)" }));
    el.appendChild(table("h-issues", [{ key: "n", label: "vezes", num: true }, { key: "level", label: "nível", render: function (r) { return levelChip(r.level === "error" ? "error" : "warn"); } }, { key: "msg", label: "mensagem", cls: "cmd" }, { key: "last", label: "última", num: true, fmt: fmtAgo }], w.topIssues, { sort: "n" }));
  }

  /* ─────────── Turn-gate ─────────── */
  function renderGate() {
    var d = S.overview; if (!d) return;
    var el = clear($("tab-gate"));
    var g = d.gate;
    badge("gate", g.pools.main.queued + g.pools.bg.queued || "");
    el.appendChild(h("h2", { text: "Pools" }));
    el.appendChild(table("gate-pools", [
      { key: "name", label: "pool" },
      { key: "active", label: "rodando", num: true, render: function (r) { return h("div", { cls: "row" }, r.active + "/" + r.max, meter(r.active, r.max)); } },
      { key: "queued", label: "na fila", num: true },
      { key: "grants", label: "concessões", num: true },
      { key: "waited", label: "esperaram", num: true },
      { key: "forced", label: "liberados à força", num: true },
      { key: "waitP50Ms", label: "espera p50", num: true, fmt: fmtMs },
      { key: "waitP95Ms", label: "espera p95", num: true, fmt: fmtMs },
      { key: "waitMaxMs", label: "espera máx", num: true, fmt: fmtMs }
    ], ["main", "bg"].map(function (n) { var p = g.pools[n]; p.name = n; return p; })));
    el.appendChild(h("p", { cls: "muted small", text: "main = turnos de agentes (THE_DUDES_MAX_CLI_TURNS) · bg = summarizer/one-shot/efêmeros (THE_DUDES_MAX_BG_CLI_TURNS) · claude contínuo e dsh NÃO passam pelo gate · anti-deadlock libera slot preso após " + fmtMs(g.maxHoldMs) + "." }));
    el.appendChild(h("h2", { text: "Segurando slot (" + g.holders.length + ")" }));
    el.appendChild(table("gate-holders", [{ key: "label", label: "runner:agente" }, { key: "pool", label: "pool" }, { key: "heldMs", label: "há", num: true, fmt: fmtMs }], g.holders, { sort: "heldMs", empty: "nenhum slot ocupado" }));
    el.appendChild(h("h2", { text: "Esperando slot (" + g.waiters.length + ")" }));
    el.appendChild(table("gate-waiters", [{ key: "label", label: "runner:agente" }, { key: "pool", label: "pool" }, { key: "waitingMs", label: "esperando há", num: true, fmt: fmtMs }], g.waiters, { sort: "waitingMs", empty: "ninguém esperando" }));
    el.appendChild(h("div", { cls: "grid" }, lineChart({ id: "gate2", title: "Pool main", unit: "turnos", points: S.series.slice(-720), series: [{ key: "gateActive", name: "rodando" }, { key: "gateQueued", name: "na fila" }] }),
      lineChart({ id: "gate3", title: "Pool bg", unit: "turnos", points: S.series.slice(-720), series: [{ key: "bgActive", name: "rodando" }, { key: "bgQueued", name: "na fila" }] })));
  }

  /* ─────────── Processos ─────────── */
  function renderProcs(p, sp) {
    var el = clear($("tab-procs"));
    badge("procs", p.hotOrphans.length ? "⚠ " + p.hotOrphans.length : p.orphans.length ? String(p.orphans.length) : "");
    el.appendChild(h("div", { cls: "row" },
      h("button", { cls: "primary", text: "amostrar agora", on: { click: function () { api("/api/procs?fresh=1").then(function () { tick(true); }); } } }),
      h("span", { cls: "muted", text: "amostra de " + fmtAgo(p.ts) + " · ps levou " + fmtMs(p.tookMs) + " · " + p.hostProcs + " processos no host" + (p.error ? " · ERRO: " + p.error : "") + " · CPU% = delta do tempo de CPU entre amostras (5s com o dashboard aberto)" })));
    if (p.self) el.appendChild(kv([["daemon", "pid " + p.self.pid + " · pri " + p.self.pri + " · nice " + p.self.nice + " · CPU " + pct(p.self.cpuPct) + " · RSS " + (p.self.rssKb / 1024).toFixed(1) + " MB · stat " + p.self.stat], ["prioridade dos filhos", Object.keys(p.priCounts || {}).map(function (k) { return "pri " + k + ": " + p.priCounts[k]; }).join(" · ") || "–"]]));
    el.appendChild(h("h2", { text: "Por agente" }));
    el.appendChild(table("procs-agent", [
      { key: "agentId", label: "agente", fmt: function (v) { return v === "(daemon)" ? "(sem agente)" : agentName(v); } },
      { key: "procs", label: "processos", num: true },
      { key: "cpuPct", label: "CPU", num: true, fmt: pct },
      { key: "rssMb", label: "RSS MB", num: true }
    ], p.byAgent, { sort: "cpuPct" }));
    el.appendChild(h("h2", { text: "Árvore de processos do daemon (" + p.tree.length + " · CPU " + pct(p.totals.cpuPct) + " · " + p.totals.rssMb + " MB)" }));
    el.appendChild(table("procs-tree", [
      { key: "pid", label: "pid", num: true, render: function (r) { return h("span", { cls: "mono" }, new Array(r.depth + 1).join("  ") + (r.depth ? "└ " : "") + r.pid); } },
      { key: "ppid", label: "ppid", num: true },
      { key: "stat", label: "stat", help: "R=rodando S=dormindo U/D=espera ininterrupta Z=zumbi T=parado N=nice" },
      { key: "pri", label: "pri", num: true, render: priCell, help: "prioridade do escalonador (macOS: 31 app/terminal · 20 LaunchAgent Standard · 4 BACKGROUND estrangulado)" },
      { key: "nice", label: "nice", num: true },
      { key: "cpuPct", label: "CPU", num: true, fmt: pct },
      { key: "psCpu", label: "%cpu ps", num: true },
      { key: "rssKb", label: "RSS MB", num: true, fmt: function (v) { return (v / 1024).toFixed(1); } },
      { key: "cpuMs", label: "CPU total", num: true, fmt: fmtMs },
      { key: "elapsedMs", label: "idade", num: true, fmt: fmtMs },
      { key: "agentId", label: "agente", fmt: function (v) { return v ? agentName(v) : "–"; } },
      { key: "command", label: "comando", cls: "cmd" }
    ], p.tree, { empty: "sem filhos" }));
    el.appendChild(h("h2", { text: "Órfãos suspeitos (" + p.orphans.length + ")" }));
    el.appendChild(table("procs-orphans", [
      { key: "pid", label: "pid", num: true }, { key: "stat", label: "stat" }, { key: "cpuPct", label: "CPU", num: true, fmt: pct },
      { key: "rssKb", label: "RSS MB", num: true, fmt: function (v) { return (v / 1024).toFixed(1); } }, { key: "elapsedMs", label: "idade", num: true, fmt: fmtMs },
      { key: "command", label: "comando", cls: "cmd" }
    ], p.orphans, { sort: "elapsedMs", empty: "nenhum órfão de runner/bridge" }));
    el.appendChild(h("h2", { text: "Órfãos quentes fora do daemon (" + p.hotOrphans.length + ")" }));
    el.appendChild(h("p", { cls: "muted small", text: "ppid 1, vivos há ≥1h, ≥5% de CPU, fora de /System e /usr/libexec — geradores de carga e probes de teste esquecidos disputam a CPU com os runners." }));
    el.appendChild(table("procs-hot", [
      { key: "pid", label: "pid", num: true }, { key: "pgid", label: "pgid", num: true }, { key: "pri", label: "pri", num: true, render: priCell }, { key: "stat", label: "stat" },
      { key: "cpuPct", label: "CPU", num: true, fmt: pct }, { key: "rssKb", label: "RSS MB", num: true, fmt: function (v) { return (v / 1024).toFixed(1); } },
      { key: "elapsedMs", label: "idade", num: true, fmt: fmtMs }, { key: "command", label: "comando", cls: "cmd" }
    ], p.hotOrphans, { sort: "cpuPct", empty: "nenhum" }));
    el.appendChild(h("h2", { text: "Top de CPU do host" }));
    el.appendChild(table("procs-top", [
      { key: "pid", label: "pid", num: true }, { key: "pri", label: "pri", num: true, render: priCell }, { key: "cpuPct", label: "CPU", num: true, fmt: pct }, { key: "psCpu", label: "%cpu ps", num: true },
      { key: "rssKb", label: "RSS MB", num: true, fmt: function (v) { return (v / 1024).toFixed(1); } }, { key: "elapsedMs", label: "idade", num: true, fmt: fmtMs },
      { key: "mine", label: "do daemon", render: function (r) { return r.mine ? chip("info", "◆", "daemon") : ""; } },
      { key: "command", label: "comando", cls: "cmd" }
    ], p.hostTop, { sort: "cpuPct" }));
    el.appendChild(h("h2", { text: "Spawns por comando" }));
    el.appendChild(table("spawn-agg", [
      { key: "cmd", label: "comando" }, { key: "spawns", label: "spawns", num: true }, { key: "live", label: "vivos", num: true },
      { key: "errors", label: "erro de spawn", num: true }, { key: "nonZeroExit", label: "exit ≠ 0", num: true }, { key: "signaled", label: "por sinal", num: true },
      { key: "avgMs", label: "duração média", num: true, fmt: fmtMs },
      { key: "p95", label: "p95", num: true, sortv: function (r) { return r.duration.p95; }, render: function (r) { return fmtMs(r.duration.p95); } },
      { key: "maxMs", label: "máx", num: true, fmt: fmtMs }
    ], sp.byCommand, { sort: "spawns" }));
    el.appendChild(h("h2", { text: "Spawns recentes (" + sp.total + " no total)" }));
    el.appendChild(table("spawn-recent", [
      { key: "startedAt", label: "início", fmt: fmtTime }, { key: "cmd", label: "comando" }, { key: "pid", label: "pid", num: true },
      { key: "agentId", label: "agente", fmt: function (v) { return v ? agentName(v) : "–"; } },
      { key: "durationMs", label: "duração", num: true, render: function (r) { return r.endedAt ? fmtMs(r.durationMs) : h("span", null, chip("info", "▶", "vivo"), " " + fmtMs(Date.now() - r.startedAt)); }, sortv: function (r) { return r.endedAt ? r.durationMs : Date.now() - r.startedAt; } },
      { key: "exitCode", label: "exit", render: function (r) { return r.error ? chip("critical", "✖", r.error) : r.signal ? chip("serious", "⚡", r.signal) : r.exitCode == null ? "–" : r.exitCode === 0 ? chip("good", "✓", "0") : chip("critical", "✖", String(r.exitCode)); } },
      { key: "args", label: "argumentos", cls: "cmd" }, { key: "cwd", label: "cwd", cls: "cmd" }
    ], sp.recent.slice().reverse(), { sort: "startedAt", limit: 500 }));
  }

  /* ─────────── Event loop ─────────── */
  function renderLoop(d) {
    var el = clear($("tab-loop"));
    var l = d.loop || { window: {}, total: {} };
    badge("loop", S.overview && S.overview.stalls5m ? S.overview.stalls5m : "");
    el.appendChild(h("p", { cls: "muted", text: "O daemon inteiro roda num thread só: enquanto ele está bloqueado (chamada síncrona, JSON gigante, cripto, GC), NENHUM runner é atendido — stdout dos CLIs fica parado, o WS atrasa e os watchdogs atrasam." }));
    el.appendChild(h("div", { cls: "kpis" },
      tile("p50 (janela)", fmtMs(l.window.p50)), tile("p99 (janela)", fmtMs(l.window.p99)), tile("máx (janela)", fmtMs(l.window.max)),
      tile("p99 desde o boot", fmtMs(l.total.p99), "máx " + fmtMs(l.total.max)), tile("ELU", pct(l.eluPct), "fração do tempo com o loop ocupado"),
      tile("Travamentos", String(d.stalls.total), "p50 " + fmtMs(d.stalls.dist.p50) + " · máx " + fmtMs(d.stalls.dist.max))));
    var P = S.series.slice(-720);
    el.appendChild(h("div", { cls: "grid" },
      lineChart({ id: "el2", title: "Atraso do event loop", unit: "ms", points: P, fmt: fmtMs, series: [{ key: "elP50", name: "p50" }, { key: "elP99", name: "p99" }, { key: "elMax", name: "máx" }] }),
      lineChart({ id: "elu", title: "Utilização do event loop", unit: "%", points: P, area: true, fmt: pct, series: [{ key: "eluPct", name: "ELU" }] }),
      lineChart({ id: "stall", title: "Travamentos ≥150ms", unit: "por amostra de 5s", points: P, area: true, series: [{ key: "stalls", name: "travamentos" }] }),
      lineChart({ id: "sync2", title: "Tempo em chamadas síncronas", unit: "ms por 5s", points: P, area: true, fmt: fmtMs, series: [{ key: "syncMs", name: "bloqueado" }] })));
    el.appendChild(h("h2", { text: "Travamentos recentes" }));
    el.appendChild(table("stalls", [
      { key: "ts", label: "hora", fmt: fmtTime }, { key: "blockedMs", label: "bloqueado", num: true, fmt: fmtMs },
      { key: "inbound", label: "msg do orchestrator em processamento" },
      { key: "syncOps", label: "chamadas síncronas na janela", render: function (r) { return h("div", { cls: "mono wrap" }, r.syncOps.join("\n") || "—"); } },
      { key: "logs", label: "logs na janela", render: function (r) { return h("div", { cls: "mono wrap small" }, r.logs.join("\n") || "—"); } }
    ], d.stalls.recent.slice().reverse(), { sort: "ts", empty: "nenhum travamento ≥150ms registrado" }));
    el.appendChild(h("h2", { text: "Chamadas síncronas por função" }));
    el.appendChild(table("sync-fn", [
      { key: "fn", label: "função" }, { key: "count", label: "chamadas", num: true }, { key: "totalMs", label: "tempo total", num: true, fmt: fmtMs },
      { key: "avgMs", label: "média", num: true, fmt: fmtMs }, { key: "maxMs", label: "máx", num: true, fmt: fmtMs }, { key: "slow", label: "lentas/registradas", num: true }
    ], d.sync.byFn, { sort: "totalMs" }));
    el.appendChild(h("h2", { text: "Chamadas síncronas lentas (child_process sempre; fs ≥15ms)" }));
    el.appendChild(table("sync-recent", [
      { key: "ts", label: "hora", fmt: fmtTime }, { key: "fn", label: "função" }, { key: "ms", label: "duração", num: true, fmt: fmtMs },
      { key: "target", label: "alvo", cls: "cmd" },
      { key: "status", label: "status", render: function (r) { return r.timedOut ? chip("critical", "⏱", "timeout") : r.status == null ? "–" : String(r.status); } },
      { key: "stack", label: "origem (stack)", render: function (r) { return h("span", { cls: "mono small wrap", text: r.stack }); } }
    ], d.sync.recent.slice().reverse(), { sort: "ts", limit: 400 }));
    el.appendChild(h("h2", { text: "Garbage collection" }));
    el.appendChild(table("gc", [{ key: "kind", label: "tipo" }, { key: "count", label: "vezes", num: true }, { key: "totalMs", label: "tempo total", num: true, fmt: fmtMs }, { key: "maxMs", label: "máx", num: true, fmt: fmtMs }], d.gc.byKind, { sort: "totalMs" }));
    if (d.gc.long.length) {
      el.appendChild(h("h3", { text: "GCs ≥50ms" }));
      el.appendChild(table("gc-long", [{ key: "ts", label: "hora", fmt: fmtTime }, { key: "kind", label: "tipo" }, { key: "ms", label: "duração", num: true, fmt: fmtMs }], d.gc.long.slice().reverse(), { sort: "ts" }));
    }
  }

  /* ─────────── Relay ─────────── */
  function renderRelay(d) {
    var el = clear($("tab-relay"));
    el.appendChild(h("p", { cls: "muted", text: "Cada tool MCP do agente (send_message, list_tasks, board, …) sai do mcp-bridge pelo socket Unix do daemon e vira fetch ao orchestrator. 'peer' = tempo SÍNCRONO resolvendo o pid do processo que conectou (spawnSync perl + ps por hop) — bloqueia o loop inteiro a cada conexão nova." }));
    el.appendChild(kv([["socket", h("span", { cls: "mono", text: d.socketPath || "–" })], ["peer-pid", d.peerPid ? d.peerPid.mode + (d.peerPid.enforced ? " (exigido)" : "") : "–"], ["conexões", fmtNum(d.connections)], ["requisições", fmtNum(d.requests)], ["cache de peer por socket", d.peerCacheSize]]));
    el.appendChild(h("h2", { text: "Por operação" }));
    el.appendChild(table("relay-op", [
      { key: "op", label: "op" }, { key: "count", label: "chamadas", num: true }, { key: "errors", label: "erros", num: true },
      { key: "statuses", label: "status", render: function (r) { return Object.keys(r.statuses).map(function (k) { return k + "×" + r.statuses[k]; }).join(" "); } },
      { key: "t50", label: "total p50", num: true, sortv: function (r) { return r.total.p50; }, render: function (r) { return fmtMs(r.total.p50); } },
      { key: "t95", label: "total p95", num: true, sortv: function (r) { return r.total.p95; }, render: function (r) { return fmtMs(r.total.p95); } },
      { key: "tmx", label: "total máx", num: true, sortv: function (r) { return r.total.max; }, render: function (r) { return fmtMs(r.total.max); } },
      { key: "u95", label: "orchestrator p95", num: true, sortv: function (r) { return r.upstream.p95; }, render: function (r) { return fmtMs(r.upstream.p95); } },
      { key: "pm", label: "peer média", num: true, sortv: function (r) { return r.peer.mean; }, render: function (r) { return fmtMs(r.peer.mean); } },
      { key: "peerMaxMs", label: "peer máx", num: true, fmt: fmtMs },
      { key: "peerTotalMs", label: "peer total", num: true, fmt: fmtMs }
    ], d.byOp, { sort: "count" }));
    el.appendChild(h("h2", { text: "Requisições recentes" }));
    el.appendChild(table("relay-recent", [
      { key: "ts", label: "hora", fmt: fmtTime }, { key: "agentId", label: "agente", fmt: function (v) { return agentName(v); } }, { key: "op", label: "op" },
      { key: "status", label: "status", render: function (r) { return r.status >= 400 || r.error ? chip("critical", "✖", String(r.status)) : chip("good", "✓", String(r.status)); } },
      { key: "totalMs", label: "total", num: true, fmt: fmtMs }, { key: "upstreamMs", label: "orchestrator", num: true, fmt: fmtMs }, { key: "peerMs", label: "peer-pid", num: true, fmt: fmtMs },
      { key: "bytesIn", label: "enviado", num: true, fmt: fmtBytes }, { key: "bytesOut", label: "recebido", num: true, fmt: fmtBytes }, { key: "error", label: "erro" }
    ], d.recent.slice().reverse(), { sort: "ts", limit: 400 }));
  }

  /* ─────────── WebSocket ─────────── */
  function renderWs(d) {
    var el = clear($("tab-ws"));
    el.appendChild(kv([
      ["estado", d.readyState === 1 ? chip("good", "✓", "aberto") : chip("critical", "✖", "fechado (" + d.readyState + ")")],
      ["url", h("span", { cls: "mono", text: d.url || "–" })],
      ["conexões / quedas", d.connects + " / " + d.disconnects + " · por código " + JSON.stringify(d.byCode)],
      ["última abertura", fmtAgo(d.lastOpenAt)], ["última queda", d.lastClose ? fmtAgo(d.lastCloseAt) + " · código " + d.lastClose.code + " · " + d.lastClose.reason : "–"],
      ["buffer de saída", fmtBytes(d.bufferedAmount)], ["fila de reenvio", String(d.outboundQueued)], ["último pong", d.lastPongAgoMs != null ? fmtMs(d.lastPongAgoMs) + " atrás" : "–"],
      ["lastSeenSeq", String(d.lastSeenSeq)], ["backoff", "reconnect " + fmtMs(d.reconnectDelay) + " · transient " + fmtMs(d.transientBackoff) + " · quedas transient 5min " + d.transientRecent],
      ["RTT", "p50 " + fmtMs(d.rtt.p50) + " · p95 " + fmtMs(d.rtt.p95) + " · máx " + fmtMs(d.rtt.max) + " (" + d.rtt.n + " amostras)"],
      ["protocolo", d.protocolMismatch ? chip("critical", "✖", "versão diferente do server") : "ok"]
    ]));
    el.appendChild(h("div", { cls: "grid" }, lineChart({ id: "rtt", title: "RTT do ping WS", unit: "ms", points: d.rttSeries, fmt: fmtMs, series: [{ key: "ms", name: "RTT" }] }),
      lineChart({ id: "wsio", title: "Mensagens do WS", unit: "por 5s", points: S.series.slice(-720), series: [{ key: "wsIn", name: "recebidas" }, { key: "wsOut", name: "enviadas" }] })));
    el.appendChild(h("h2", { text: "Recebidas do orchestrator (por tipo)" }));
    el.appendChild(table("ws-in", [{ key: "type", label: "tipo" }, { key: "count", label: "qtd", num: true }, { key: "bytes", label: "bytes", num: true, fmt: fmtBytes }, { key: "handlerAvgMs", label: "handler média", num: true, fmt: fmtMs }, { key: "handlerMaxMs", label: "handler máx", num: true, fmt: fmtMs }, { key: "syncMaxMs", label: "parte síncrona máx", num: true, fmt: fmtMs }, { key: "lastAt", label: "última", num: true, fmt: fmtAgo }], d.inbound, { sort: "count" }));
    el.appendChild(h("h2", { text: "Enviadas ao orchestrator (por tipo)" }));
    el.appendChild(table("ws-out", [{ key: "type", label: "tipo" }, { key: "count", label: "qtd", num: true }, { key: "bytes", label: "bytes", num: true, fmt: fmtBytes }, { key: "drops", label: "não entregues", num: true }, { key: "lastAt", label: "última", num: true, fmt: fmtAgo }], d.outbound, { sort: "count" }));
    el.appendChild(h("h2", { text: "Eventos da conexão" }));
    el.appendChild(table("ws-ev", [{ key: "ts", label: "hora", fmt: fmtTime }, { key: "kind", label: "evento" }, { key: "detail", label: "detalhe" }], d.events.slice().reverse(), { sort: "ts" }));
  }

  /* ─────────── Eventos ─────────── */
  function renderEvents(list) {
    var el = clear($("tab-events"));
    var kinds = ["", "state", "hung-soft", "hung-hard", "park", "error", "exit", "spawn", "stop", "pause", "resume"];
    el.appendChild(h("div", { cls: "row" }, "tipo:", h("select", { on: { change: function (e) { S.eventsKind = e.target.value; tick(true); } } }, kinds.map(function (k) { return h("option", { value: k, selected: S.eventsKind === k }, k || "todos"); })),
      S.eventsAgent ? h("button", { text: "agente: " + agentName(S.eventsAgent) + " ✕", on: { click: function () { S.eventsAgent = ""; tick(true); } } }) : null));
    el.appendChild(table("events", [
      { key: "ts", label: "hora", fmt: fmtTime }, { key: "agentId", label: "agente", fmt: function (v) { return agentName(v); } },
      { key: "kind", label: "evento", render: function (r) { return r.kind === "hung-hard" || r.kind === "park" ? chip("critical", "✖", r.kind) : r.kind === "hung-soft" ? chip("warning", "▲", r.kind) : r.kind === "error" ? chip("serious", "!", r.kind) : chip("neutral", "•", r.kind); } },
      { key: "detail", label: "detalhe", render: function (r) { return h("span", { cls: "wrap", text: r.detail }); } }
    ], list.slice().reverse(), { sort: "ts" }));
  }

  /* ─────────── Logs (SSE) ─────────── */
  function renderLogsShell() {
    var el = $("tab-logs");
    if (el.firstChild) return;
    var lv = h("select", { id: "log-level", on: { change: function (e) { S.logs.level = e.target.value; paintLogs(true); } } },
      [["", "todos os níveis"], ["info", "info"], ["warn", "warn"], ["error", "error"], ["issues", "warn + error"]].map(function (o) { return h("option", { value: o[0] }, o[1]); }));
    var q = h("input", { type: "search", id: "log-q", placeholder: "filtrar texto / agentId / runner", on: { input: function (e) { S.logs.q = e.target.value; paintLogs(true); } } });
    var follow = h("button", { id: "log-follow", text: "seguindo ✓", on: { click: function () { S.logs.follow = !S.logs.follow; follow.textContent = S.logs.follow ? "seguindo ✓" : "seguir"; if (S.logs.follow) paintLogs(false); } } });
    var pause = h("button", { id: "log-pause", text: "pausar", on: { click: function () { S.logs.paused = !S.logs.paused; pause.textContent = S.logs.paused ? "retomar" : "pausar"; if (!S.logs.paused) paintLogs(true); } } });
    el.appendChild(h("div", { cls: "row" }, lv, q, follow, pause, h("button", { text: "limpar tela", on: { click: function () { S.logs.lines = []; paintLogs(true); } } }), h("span", { id: "log-info", cls: "muted" })));
    el.appendChild(h("div", { cls: "logview", id: "logview" }));
  }
  function logMatch(l) {
    var lv = S.logs.level;
    if (lv === "issues" && l.level === "info") return false;
    if (lv && lv !== "issues" && l.level !== lv) return false;
    if (S.logs.q && l.msg.toLowerCase().indexOf(S.logs.q.toLowerCase()) < 0) return false;
    return true;
  }
  function logRow(l) {
    var ic = l.level === "error" ? chip("critical", "✖", "error") : l.level === "warn" ? chip("warning", "▲", "warn") : h("span", { cls: "muted", text: "info" });
    return h("div", { cls: "logline" + (l.level === "error" ? " err" : "") }, h("span", { cls: "muted", text: fmtTime(l.ts) }), h("span", { cls: "lv" }, ic), h("span", { cls: "m", text: (l.src !== "daemon" ? "[" + l.src + "] " : "") + l.msg }));
  }
  var paintPending = false;
  function paintLogs(full) {
    var box = $("logview"); if (!box) return;
    if (S.logs.paused && !full) return;
    if (full) {
      clear(box);
      var shown = S.logs.lines.filter(logMatch).slice(-2500);
      var frag = document.createDocumentFragment();
      shown.forEach(function (l) { frag.appendChild(logRow(l)); });
      box.appendChild(frag);
    }
    var info = $("log-info");
    if (info) info.textContent = S.logs.lines.length + " linhas em memória no navegador · stream " + (S.logs.es ? "conectado" : "desconectado");
    if (S.logs.follow) box.scrollTop = box.scrollHeight;
  }
  function openLogStream() {
    renderLogsShell();
    $("log-q").value = S.logs.q;
    if (S.logs.es) { paintLogs(true); return; }
    var start = function () {
      var es = new EventSource("/api/logs/stream?since=" + S.logs.lastSeq);
      S.logs.es = es;
      es.onmessage = function (ev) {
        var l = JSON.parse(ev.data);
        if (l.seq <= S.logs.lastSeq) return;
        S.logs.lastSeq = l.seq;
        S.logs.lines.push(l);
        if (S.logs.lines.length > 20000) S.logs.lines.splice(0, S.logs.lines.length - 20000);
        if (S.logs.paused || !logMatch(l)) return;
        var box = $("logview");
        if (box) {
          box.appendChild(logRow(l));
          while (box.childNodes.length > 3000) box.removeChild(box.firstChild);
          if (!paintPending) { paintPending = true; requestAnimationFrame(function () { paintPending = false; paintLogs(false); }); }
        }
      };
      es.onerror = function () { paintLogs(false); };
    };
    if (S.logs.lastSeq === 0) {
      api("/api/logs?limit=3000").then(function (d) {
        S.logs.lines = d.lines;
        S.logs.lastSeq = d.lastSeq;
        paintLogs(true);
        start();
      }).catch(showError);
    } else { paintLogs(true); start(); }
  }
  function closeLogStream() { if (S.logs.es) { S.logs.es.close(); S.logs.es = null; } }

  /* ─────────── Captura CLI ─────────── */
  function renderCapture(d) {
    var el = clear($("tab-capture"));
    badge("capture", d.on ? "on" : "");
    el.appendChild(h("p", { cls: "muted", text: "Captura o I/O cru dos CLIs (argv, stdin, stdout, stderr) num ring em memória (1500 trechos de até 4KB). Contém PLAINTEXT das conversas — fica só na memória deste daemon e só sai por este servidor loopback autenticado. Desligada por padrão; desliga sozinha no restart (ou fixe com THE_DUDES_DEBUG_CLI_CAPTURE=1)." }));
    el.appendChild(h("div", { cls: "row" },
      d.on ? chip("warning", "●", "capturando") : chip("neutral", "○", "desligada"),
      h("button", { cls: d.on ? "" : "primary", text: d.on ? "desligar captura" : "ligar captura", on: { click: function () { post("/api/cli-capture", { on: !d.on }).then(function () { tick(true); }).catch(showError); } } })));
    el.appendChild(table("capture", [
      { key: "ts", label: "hora", fmt: fmtTime }, { key: "agentId", label: "agente", fmt: function (v) { return agentName(v); } }, { key: "runner", label: "runner" }, { key: "dir", label: "direção" },
      { key: "text", label: "conteúdo", render: function (r) { return h("div", { cls: "mono wrap small", text: r.text }); } }
    ], d.lines.slice().reverse(), { sort: "ts", empty: d.on ? "nada capturado ainda" : "captura desligada" }));
  }

  /* ─────────── Config ─────────── */
  function renderConfig(d) {
    var el = clear($("tab-config"));
    el.appendChild(h("h2", { text: "Identidade" }));
    el.appendChild(h("pre", { cls: "json", text: JSON.stringify(d.identity, null, 2) }));
    el.appendChild(h("h2", { text: "Runners (CLIs)" }));
    var cmds = d.runners.commands || {};
    el.appendChild(table("cli", [
      { key: "name", label: "runner" }, { key: "available", label: "disponível", render: function (r) { return r.available ? chip("good", "✓", "sim") : chip("critical", "✖", "não"); } },
      { key: "source", label: "origem" }, { key: "command", label: "comando", cls: "cmd" }, { key: "resolvedPath", label: "caminho", cls: "cmd" }, { key: "probeReason", label: "sonda", cls: "cmd" }
    ], Object.keys(cmds).map(function (k) { var c = cmds[k]; c.name = k; return c; }), { sort: "name", asc: true }));
    el.appendChild(h("pre", { cls: "json", text: JSON.stringify({ available: d.runners.available, installed: d.runners.installed }, null, 2) }));
    el.appendChild(h("h2", { text: "Ambiente (segredos redatados)" }));
    el.appendChild(table("env", [{ key: "k", label: "variável" }, { key: "v", label: "valor", cls: "cmd" }], Object.keys(d.env).map(function (k) { return { k: k, v: d.env[k] }; }), { sort: "k", asc: true }));
    el.appendChild(h("h2", { text: "Health (o que vai ao server a cada 15s)" }));
    el.appendChild(h("pre", { cls: "json", text: JSON.stringify(d.health, null, 2) }));
  }

  /* ─────────── Diagnóstico ─────────── */
  function renderDiag() {
    var el = $("tab-diag");
    if (el.firstChild) return;
    var secs = h("select", null, [5, 10, 20, 30, 60].map(function (n) { return h("option", { value: n, selected: n === 10 }, n + " s"); }));
    var out = h("div", { id: "diag-out" });
    var btn = h("button", { cls: "primary", text: "gravar CPU profile", on: { click: function () {
      btn.disabled = true;
      btn.textContent = "gravando " + secs.value + "s…";
      post("/api/diag/cpu-profile?seconds=" + secs.value).then(function (r) {
        S.lastProfile = r;
        clear(out);
        out.appendChild(h("p", null, "Arquivo: ", h("span", { cls: "mono", text: r.file }), " · ", h("a", { href: "/api/diag/file?name=" + encodeURIComponent(r.name), text: "baixar .cpuprofile" }), h("span", { cls: "muted", text: " (abra no Chrome DevTools → Performance, ou em speedscope)" })));
        out.appendChild(table("prof", [{ key: "fn", label: "função" }, { key: "where", label: "onde", cls: "cmd" }, { key: "selfMs", label: "self", num: true, fmt: fmtMs }, { key: "pct", label: "%", num: true, fmt: pct }], r.top, { sort: "selfMs" }));
      }).catch(showError).then(function () { btn.disabled = false; btn.textContent = "gravar CPU profile"; });
    } } });
    el.appendChild(h("h2", { text: "CPU profile do daemon" }));
    el.appendChild(h("p", { cls: "muted", text: "Amostra a pilha JS do daemon (intervalo de 0,5ms) e mostra onde o thread principal gasta tempo — inclusive dentro de spawnSync/execFileSync. Use enquanto o problema está acontecendo." }));
    el.appendChild(h("div", { cls: "row" }, "duração:", secs, btn));
    el.appendChild(out);
    var hout = h("div");
    var hbtn = h("button", { text: "gravar heap snapshot", on: { click: function () {
      if (!confirm("O heap snapshot BLOQUEIA o daemon inteiro enquanto grava (segundos, pode ser mais com heap grande). Continuar?")) return;
      hbtn.disabled = true;
      post("/api/diag/heap-snapshot").then(function (r) {
        clear(hout);
        hout.appendChild(h("p", null, "Gravado em ", h("span", { cls: "mono", text: r.file }), " · " + fmtBytes(r.bytes) + " em " + fmtMs(r.ms) + " · ", h("a", { href: "/api/diag/file?name=" + encodeURIComponent(r.name), text: "baixar" })));
      }).catch(showError).then(function () { hbtn.disabled = false; });
    } } });
    el.appendChild(h("h2", { text: "Heap snapshot" }));
    el.appendChild(h("div", { cls: "row" }, hbtn, h("span", { cls: "muted", text: "para vazamento de memória (abrir no Chrome DevTools → Memory)" })));
    el.appendChild(hout);
    var rout = h("div");
    el.appendChild(h("h2", { text: "Relatório do Node (process.report, sem variáveis de ambiente)" }));
    el.appendChild(h("div", { cls: "row" }, h("button", { text: "gerar relatório", on: { click: function () {
      api("/api/diag/report").then(function (r) {
        clear(rout);
        var handles = (r.libuv || []).map(function (x) { return { type: x.type, is_active: x.is_active, is_referenced: x.is_referenced, detail: x.address || x.localEndpoint && JSON.stringify(x.localEndpoint) || x.filename || x.signal || x.repeat || "" }; });
        rout.appendChild(h("h3", { text: "Handles do libuv (" + handles.length + ")" }));
        rout.appendChild(table("uv", [{ key: "type", label: "tipo" }, { key: "is_active", label: "ativo" }, { key: "is_referenced", label: "ref" }, { key: "detail", label: "detalhe", cls: "cmd" }], handles, { sort: "type", asc: true }));
        rout.appendChild(h("h3", { text: "Pilha JS no momento" }));
        rout.appendChild(h("pre", { cls: "json", text: JSON.stringify(r.javascriptStack, null, 2) }));
        rout.appendChild(h("details", null, h("summary", { text: "relatório completo" }), h("pre", { cls: "json", text: JSON.stringify(r, null, 2) })));
      }).catch(showError);
    } } })));
    el.appendChild(rout);
    el.appendChild(h("h2", { text: "Exportar tudo" }));
    el.appendChild(h("p", null, h("a", { href: "/api/export", text: "baixar JSON com todo o estado do dashboard" }), h("span", { cls: "muted", text: " (logs, turnos, processos, séries, relay, WS, eventos, config redatada) — útil para anexar num card." })));
  }

  /* ─────────── ciclo de atualização ─────────── */
  function showError(e) {
    var b = $("err");
    b.textContent = "⚠ " + (e && e.message ? e.message : String(e));
    b.style.display = "block";
  }
  function hideError() { $("err").style.display = "none"; }
  function header(d) {
    var id = d.identity;
    $("who").textContent = (id.name || "?") + " · v" + id.version + " · pid " + id.pid + " · " + (id.hostname || "") + " · up " + fmtMs(d.process.uptimeS * 1000) + " · perfil " + (id.profileHome || "?");
    $("upd").textContent = "atualizado " + fmtTime(d.now);
    S.agentsById = {};
    d.agents.forEach(function (a) { S.agentsById[a.agentId] = a; });
    document.title = ((d.alerts || []).some(function (a) { return a.level === "crit"; }) ? "✖ " : "") + (id.name || "daemon") + " · debug";
  }
  function tick(force) {
    if (S.busy || (S.paused && !force)) return;
    if (document.visibilityState === "hidden" && !force) return;
    S.busy = true;
    var jobs = [api("/api/overview").then(function (d) { S.overview = d; header(d); })];
    if (Date.now() - S.seriesAt > 4500 || force) jobs.push(api("/api/series?limit=720").then(function (d) { S.series = d.points; S.seriesAt = Date.now(); }));
    var t = S.tab;
    var extra = null;
    if (t === "history") extra = api("/api/history");
    else if (t === "turns") extra = api("/api/turns?windowMin=" + S.turnWindow + "&limit=800" + (S.turnRunner ? "&runner=" + encodeURIComponent(S.turnRunner) : "") + (S.turnAgent ? "&agent=" + encodeURIComponent(S.turnAgent) : ""));
    else if (t === "procs") extra = Promise.all([api("/api/procs"), api("/api/spawns?limit=500")]);
    else if (t === "loop") extra = api("/api/loop");
    else if (t === "relay") extra = api("/api/relay?limit=400");
    else if (t === "ws") extra = api("/api/ws");
    else if (t === "events") extra = api("/api/events?limit=800" + (S.eventsAgent ? "&agent=" + encodeURIComponent(S.eventsAgent) : "") + (S.eventsKind ? "&kinds=" + S.eventsKind : ""));
    else if (t === "capture") extra = api("/api/cli-capture?limit=600");
    else if (t === "config") extra = S.configLoaded && !force ? null : api("/api/config");
    if (extra) jobs.push(extra);
    Promise.all(jobs).then(function (res) {
      hideError();
      var data = extra ? res[res.length - 1] : null;
      var render = function () {
        if (t === "overview") renderOverview();
        else if (t === "agents") renderAgents();
        else if (t === "gate") renderGate();
        else if (t === "turns") renderTurns(data);
        else if (t === "history") renderHistory(data);
        else if (t === "procs") renderProcs(data[0], data[1]);
        else if (t === "loop") renderLoop(data);
        else if (t === "relay") renderRelay(data);
        else if (t === "ws") renderWs(data);
        else if (t === "events") renderEvents(data);
        else if (t === "capture") renderCapture(data);
        else if (t === "config") { if (data) { S.configLoaded = true; renderConfig(data); } }
        else if (t === "diag") renderDiag();
        else if (t === "logs") paintLogs(false);
      };
      if (t === S.tab) {
        lastRender = render;
        // Não arranca o gráfico debaixo do mouse nem desfaz texto selecionado.
        var sel = window.getSelection ? String(window.getSelection()) : "";
        if (force || (Date.now() > (S.hoverUntil || 0) && !sel)) render();
      }
      var d = S.overview;
      if (d) {
        badge("overview", (d.alerts || []).filter(function (a) { return a.level !== "info"; }).length || "");
        badge("gate", d.gate.pools.main.queued + d.gate.pools.bg.queued || "");
        badge("agents", d.agents.length || "");
        badge("loop", d.stalls5m || "");
      }
    }).catch(showError).then(function () { S.busy = false; });
  }
  function schedule() {
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(function () { tick(false); }, S.intervalMs);
  }
  $("interval").addEventListener("change", function (e) { S.intervalMs = Number(e.target.value); schedule(); });
  $("pause").addEventListener("click", function () {
    S.paused = !S.paused;
    $("pause").textContent = S.paused ? "retomar" : "pausar";
    document.body.classList.toggle("stale", S.paused);
  });
  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    rerender();
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") tick(true); });
  var initial = (location.hash || "").slice(1);
  setTab(TABS.some(function (t) { return t[0] === initial; }) ? initial : "overview");
  schedule();
})();
`;

export function dashboardHtml(nonce: string): string {
  return [
    "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>daemon · debug</title><link rel=\"icon\" href=\"data:,\">",
    `<style nonce="${nonce}">${CSS}</style></head><body>`,
    "<header><div class=\"top\"><span class=\"brand\">the-dudes daemon · debug</span><span class=\"who\" id=\"who\">carregando…</span>",
    "<span class=\"spacer\"></span><span class=\"ctl\"><span id=\"upd\" class=\"muted\"></span>",
    "<select id=\"interval\" title=\"intervalo de atualização\"><option value=\"1000\">1s</option><option value=\"2000\" selected>2s</option><option value=\"5000\">5s</option><option value=\"10000\">10s</option></select>",
    "<button id=\"pause\">pausar</button><button id=\"theme\" title=\"alternar claro/escuro\">◐</button>",
    "<a class=\"btnlink\" href=\"/api/export\">exportar JSON</a></span></div>",
    "<nav id=\"nav\"></nav></header>",
    "<div id=\"err\" class=\"alert crit\"></div>",
    "<main id=\"main\"></main>",
    `<script nonce="${nonce}">${JS}</script></body></html>`,
  ].join("");
}

/** Só para teste: o JS/CSS embutidos (checagem de sintaxe e de crase/"${"). */
export const _dashboardAssetsForTest = { CSS, JS };
