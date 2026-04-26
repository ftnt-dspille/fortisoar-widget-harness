/* In-page debug drawer: Errors / Network / Console tabs.
   Loaded as a sibling script before the harness boot IIFE so console hooks
   capture output from any subsequently loaded controllers. Communicates with
   the rest of the page via window.__harness* globals (drawer events come
   from $exceptionHandler, fetch wrappers, and the SSE channel). */
"use strict";
(function () {
  const MAX = 200;
  const buffers = { errors: [], network: [], console: [] };
  const seen = { errors: 0, network: 0, console: 0 };
  let active = "errors";
  const expanded = new Set();
  let filter = "";

  const $ = (id) => document.getElementById(id);
  const drawerEl = $("harness-drawer");
  const bodyEl = $("drawer-body");
  const filterEl = $("drawer-filter");
  if (!drawerEl || !bodyEl) return;

  function isOpen() { return drawerEl.classList.contains("open"); }
  function setOpen(v) {
    drawerEl.classList.toggle("open", v);
    document.body.classList.toggle("has-drawer-open", v);
    localStorage.setItem("harness.drawer.open", v ? "1" : "0");
    if (v) { seen[active] = buffers[active].length; updateBadges(); render(); }
  }

  function push(kind, entry) {
    const buf = buffers[kind];
    const tagged = Object.assign({ _id: Date.now() + ":" + Math.random().toString(36).slice(2, 7) }, entry);
    buf.push(tagged);
    if (buf.length > MAX) buf.shift();
    if (isOpen() && active === kind) { seen[kind] = buf.length; render(); }
    updateBadges();
  }

  function updateBadges() {
    for (const k of ["errors", "network", "console"]) {
      const unread = buffers[k].length - seen[k];
      const el = $("tab-badge-" + k);
      if (!el) continue;
      if (unread > 0) { el.style.display = ""; el.textContent = String(unread); }
      else el.style.display = "none";
    }
    const errCount = buffers.errors.length;
    const errEl = $("drawer-error-count");
    if (errEl) {
      if (errCount > 0) { errEl.style.display = ""; errEl.textContent = String(errCount); }
      else errEl.style.display = "none";
    }
  }

  function statusClass(status) {
    if (status === 0) return "status-0";
    if (status >= 500) return "status-5xx";
    if (status >= 400) return "status-4xx";
    if (status >= 300) return "status-3xx";
    return "status-2xx";
  }
  function fmtBody(body) {
    if (!body) return "";
    let text = body.text || "";
    if (body.binary) return "<binary " + (body.truncated ? "(truncated) " : "") + "data>";
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
    return text + (body.truncated ? "\n…(truncated)" : "");
  }
  function rowMatchesFilter(row, kind) {
    if (!filter) return true;
    const f = filter.toLowerCase();
    if (kind === "errors") return (row.message || "").toLowerCase().includes(f);
    if (kind === "network") return (row.url || "").toLowerCase().includes(f) || String(row.status).includes(f);
    if (kind === "console") return (row.text || "").toLowerCase().includes(f);
    return true;
  }

  function el(tag, opts) {
    const n = document.createElement(tag);
    if (opts) {
      if (opts.className) n.className = opts.className;
      if (opts.text != null) n.textContent = opts.text;
      if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, v);
    }
    return n;
  }
  function meta(text) { return el("span", { className: "meta", text: text }); }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderRow(r) {
    const isExp = expanded.has(r._id);
    const row = el("div", {
      className: "harness-drawer-row" + (isExp ? " expanded" : ""),
      attrs: { "data-id": r._id },
    });
    if (active === "errors") {
      row.appendChild(meta(r.source || "js"));
      row.appendChild(document.createTextNode(r.message || "(no message)"));
      if (isExp && r.stack) {
        const det = el("div", { className: "harness-drawer-detail" });
        det.appendChild(el("pre", { text: r.stack }));
        row.appendChild(det);
      }
    } else if (active === "network") {
      row.appendChild(meta(new Date(r.ts).toLocaleTimeString()));
      row.appendChild(el("span", { className: statusClass(r.status), text: String(r.status || "ERR") }));
      row.appendChild(document.createTextNode(" " + r.method + " " + r.url));
      const tail = " (" + r.ms + "ms" + (r.resBodyLength != null ? ", " + r.resBodyLength + "b" : "") + ")";
      row.appendChild(meta(tail));
      if (isExp) {
        const det = el("div", { className: "harness-drawer-detail" });
        if (r.error) det.appendChild(el("div", { text: "error: " + r.error }));
        if (r.resBody) {
          det.appendChild(el("div", { text: "response:" }));
          det.appendChild(el("pre", { text: fmtBody(r.resBody) }));
        }
        row.appendChild(det);
      }
    } else if (active === "console") {
      row.appendChild(meta(r.level || "log"));
      row.appendChild(document.createTextNode(r.text || ""));
    }
    row.addEventListener("click", function () {
      if (expanded.has(r._id)) expanded.delete(r._id); else expanded.add(r._id);
      render();
    });
    return row;
  }

  function render() {
    clear(bodyEl);
    const buf = buffers[active].filter((r) => rowMatchesFilter(r, active));
    if (buf.length === 0) {
      bodyEl.appendChild(el("div", { className: "harness-drawer-empty", text: "no " + active + " yet" }));
      return;
    }
    for (let i = buf.length - 1; i >= 0; i--) bodyEl.appendChild(renderRow(buf[i]));
  }

  document.querySelectorAll(".harness-drawer-tab").forEach((tab) => {
    tab.addEventListener("click", function (e) {
      e.stopPropagation();
      document.querySelectorAll(".harness-drawer-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      active = tab.getAttribute("data-tab");
      expanded.clear();
      seen[active] = buffers[active].length;
      updateBadges();
      render();
    });
  });
  $("drawer-bar").addEventListener("click", function (e) {
    if (e.target.closest(".harness-drawer-tab, button, input, label")) return;
    setOpen(!isOpen());
  });
  $("drawer-collapse").addEventListener("click", function (e) { e.stopPropagation(); setOpen(false); });
  const toggleBtn = $("drawer-toggle-btn");
  if (toggleBtn) toggleBtn.addEventListener("click", () => setOpen(!isOpen()));
  $("drawer-clear").addEventListener("click", function (e) {
    e.stopPropagation();
    buffers[active].length = 0;
    seen[active] = 0;
    expanded.clear();
    updateBadges();
    render();
    if (active === "network") fetch("/_fsr/proxy-log", { method: "DELETE" }).catch(() => {});
  });
  filterEl.addEventListener("input", function () { filter = filterEl.value; render(); });

  const verboseEl = $("drawer-verbose");
  verboseEl.addEventListener("change", function () {
    fetch("/_fsr/proxy-log/verbose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verbose: verboseEl.checked }),
    }).catch(() => {});
  });

  // Capture console.* before any widget code runs. Errors also surface in
  // the Errors tab so a stray console.error stops being invisible.
  const origConsole = {};
  ["log", "warn", "error", "info", "debug"].forEach((level) => {
    origConsole[level] = console[level].bind(console);
    console[level] = function () {
      try {
        const text = Array.prototype.map.call(arguments, function (a) {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === "object") { try { return JSON.stringify(a); } catch (_) { return String(a); } }
          return String(a);
        }).join(" ");
        push("console", { level: level, text: text, ts: Date.now() });
        if (level === "error") push("errors", { source: "console.error", message: text, ts: Date.now() });
      } catch (_) {}
      origConsole[level].apply(null, arguments);
    };
  });

  window.addEventListener("error", function (ev) {
    push("errors", {
      source: "window.error",
      message: ev.message || String(ev.error),
      stack: ev.error && ev.error.stack,
      ts: Date.now(),
    });
  });
  window.addEventListener("unhandledrejection", function (ev) {
    const r = ev.reason;
    push("errors", {
      source: "unhandledrejection",
      message: (r && (r.message || String(r))) || "unhandled promise rejection",
      stack: r && r.stack,
      ts: Date.now(),
    });
  });

  window.__harnessReportError = function (e) { push("errors", Object.assign({ ts: Date.now() }, e)); };
  window.__harnessReportNetwork = function (e) { push("network", e); };
  window.__harnessProxyEvent = function (e) { push("network", e); };
  window.__harnessClearNetwork = function () {
    buffers.network.length = 0; seen.network = 0; updateBadges();
    if (active === "network") render();
  };
  window.__harnessHydrateProxy = async function () {
    try {
      const r = await fetch("/_fsr/proxy-log");
      const data = await r.json();
      buffers.network = (data.entries || []).slice(-MAX);
      seen.network = buffers.network.length;
      verboseEl.checked = !!data.verbose;
      updateBadges();
      if (active === "network") render();
    } catch (_) {}
  };
  window.__harnessSetVerboseUI = function (v) { verboseEl.checked = !!v; };

  if (localStorage.getItem("harness.drawer.open") === "1") setOpen(true);
})();
