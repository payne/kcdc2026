"use strict";

/* ---------------------------------------------------------------------
 * KCDC 2026 session browser — static, no build step, no framework.
 *
 * Routing: hash-based (`#/sessions?q=cloud&day=2026-09-09`) so every
 * filtered view is a real, bookmarkable/shareable URL. Filter/sort state
 * lives entirely in the URL query string; the URL itself is what gets
 * saved to localStorage so "last view" restoration is just "go to the
 * last URL", not a separate state format to keep in sync.
 * ------------------------------------------------------------------- */

const STORAGE_KEY = "kcdc2026:lastView";
const DATA_SESSIONS_URL = "data/kcdc-2026-sessions.json";
const DATA_YOUTUBES_URL = "data/youtubes.json";
const DB_PATH = "data/kcdc.db";

const app = document.getElementById("app");

/** @type {{sessions: any[], speakers: any[], matches: any[], speakerByName: Map<string, any>, sessionById: Map<string, any>}} */
let MODEL = null;

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------

Promise.all([
  fetch(DATA_SESSIONS_URL).then((r) => {
    if (!r.ok) throw new Error(`${DATA_SESSIONS_URL}: HTTP ${r.status}`);
    return r.json();
  }),
  fetch(DATA_YOUTUBES_URL).then((r) => {
    if (!r.ok) throw new Error(`${DATA_YOUTUBES_URL}: HTTP ${r.status}`);
    return r.json();
  }),
])
  .then(([sessionsData, youtubesData]) => {
    MODEL = buildModel(sessionsData, youtubesData);
    if (!location.hash) {
      const saved = safeGetItem(STORAGE_KEY);
      history.replaceState(null, "", saved || "#/sessions");
    }
    window.addEventListener("hashchange", render);
    render();
  })
  .catch((err) => {
    app.innerHTML = `<p class="error">Couldn't load session data: ${escapeHtml(
      String(err.message || err)
    )}<br>If you opened this file directly (file://), serve it over HTTP instead, e.g.
    <code>python3 -m http.server</code> from the <code>docs/</code> folder.</p>`;
  });

function safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* localStorage unavailable (private mode, etc.) — degrade silently */
  }
}

// ---------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------

function buildModel(sessionsData, youtubesData) {
  const matches = (youtubesData.matches || []).map((m, i) => ({
    id: i,
    sessionId: m.sessionId,
    sessionTitle: m.sessionTitle,
    speaker: m.speaker,
    youtubeUrl: m.youtubeUrl,
    videoTitle: m.videoTitle,
    channel: m.channel,
    matchType: m.matchType,
    matchConfidence: m.matchConfidence,
    notes: m.notes,
  }));

  const matchesBySession = groupBy(matches, (m) => m.sessionId);
  const matchesBySpeaker = groupBy(matches, (m) => m.speaker);

  const sessions = (sessionsData.sessions || []).map((s) => {
    const sessionMatches = matchesBySession.get(s.id) || [];
    return {
      id: s.id,
      title: s.title,
      description: s.description || "",
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      room: s.room || "",
      speakers: s.speakers || [],
      status: s.status || "",
      isServiceSession: !!s.isServiceSession,
      isPlenumSession: !!s.isPlenumSession,
      liveUrl: s.liveUrl,
      recordingUrl: s.recordingUrl,
      dayKey: s.startsAt ? s.startsAt.slice(0, 10) : "",
      matches: sessionMatches,
      hasVideo: sessionMatches.length > 0,
    };
  });

  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const unmatchedSet = new Set(youtubesData.speakersSearchedWithNoMatchFound || []);
  const speakerNames = new Set();
  sessions.forEach((s) => s.speakers.forEach((n) => speakerNames.add(n)));
  matches.forEach((m) => speakerNames.add(m.speaker));
  unmatchedSet.forEach((n) => speakerNames.add(n));

  const sessionsBySpeaker = new Map();
  sessions.forEach((s) => {
    s.speakers.forEach((name) => {
      if (!sessionsBySpeaker.has(name)) sessionsBySpeaker.set(name, []);
      sessionsBySpeaker.get(name).push(s);
    });
  });

  const speakers = Array.from(speakerNames)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const sSessions = sessionsBySpeaker.get(name) || [];
      const sMatches = matchesBySpeaker.get(name) || [];
      return {
        name,
        slug: encodeURIComponent(name),
        sessions: sSessions,
        matches: sMatches,
        hasMatch: sMatches.length > 0,
        searchedNoMatch: unmatchedSet.has(name),
      };
    });

  const speakerByName = new Map(speakers.map((s) => [s.name, s]));

  return { sessions, speakers, matches, speakerByName, sessionById };
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/sessions";
  const [path, queryStr] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const params = new URLSearchParams(queryStr || "");
  return { segments, params, raw };
}

function render() {
  if (!MODEL) return;
  const { segments, params, raw } = parseHash();
  safeSetItem(STORAGE_KEY, "#" + raw);
  updateNavHighlight(segments[0]);

  // Full re-renders replace the DOM, so a focused input (e.g. the search
  // box, typing triggers a re-render on every debounced keystroke) would
  // otherwise lose focus. Capture it here and restore it after rendering.
  const active = document.activeElement;
  const focusState =
    active && active.id === "f-q"
      ? { id: active.id, selectionStart: active.selectionStart, selectionEnd: active.selectionEnd }
      : null;

  try {
    if (segments[0] === "sessions" && segments[1]) {
      renderSessionDetail(segments[1]);
    } else if (segments[0] === "sessions" || segments.length === 0) {
      renderSessionsPage(params);
    } else if (segments[0] === "speakers" && segments[1]) {
      renderSpeakerDetail(decodeURIComponent(segments[1]));
    } else if (segments[0] === "speakers") {
      renderSpeakersPage(params);
    } else if (segments[0] === "videos") {
      renderVideosPage(params);
    } else if (segments[0] === "explore") {
      renderExplorePage();
    } else {
      renderNotFound(raw);
    }
  } catch (err) {
    app.innerHTML = `<p class="error">Something went wrong rendering this view: ${escapeHtml(
      String(err.message || err)
    )}</p>`;
    console.error(err);
  }

  if (focusState) {
    const el = document.getElementById(focusState.id);
    if (el) {
      el.focus();
      if (typeof el.setSelectionRange === "function") {
        el.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
      }
    }
  }
}

function updateNavHighlight(routeName) {
  document.querySelectorAll(".main-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === routeName);
  });
}

/** Merge `updates` into the current query params for `basePath` and navigate.
 *  Empty/undefined values remove the key. Uses replaceState so filter
 *  interactions don't spam browser history, but the URL (and therefore
 *  the bookmarkable link + localStorage "last view") always reflects
 *  the live filter state. */
function setQuery(basePath, updates) {
  const { params } = parseHash();
  Object.entries(updates).forEach(([k, v]) => {
    if (v === "" || v === null || v === undefined) params.delete(k);
    else params.set(k, v);
  });
  const qs = params.toString();
  const newHash = "#" + basePath + (qs ? "?" + qs : "");
  history.replaceState(null, "", newHash);
  render();
}

function navigate(hash) {
  location.hash = hash;
}

// ---------------------------------------------------------------------
// Shared table helper
// ---------------------------------------------------------------------

/**
 * Renders a filterable, sortable table.
 * @param {Object} opts
 * @param {string} opts.basePath - e.g. "/sessions"
 * @param {URLSearchParams} opts.params
 * @param {Array} opts.columns - [{key, label, sortable, render(row)}]
 * @param {Array} opts.rows - already-filtered, unsorted rows
 * @param {string} opts.defaultSort
 * @param {string} opts.defaultDir
 * @param {(row:any)=>string} [opts.rowHref]
 */
function renderTable(container, opts) {
  const { basePath, params, columns, rows, defaultSort, defaultDir } = opts;
  const sortKey = params.get("sort") || defaultSort;
  const sortDir = params.get("dir") || defaultDir || "asc";

  const col = columns.find((c) => c.key === sortKey) || columns[0];
  const sorted = rows.slice().sort((a, b) => {
    const av = col.sortValue ? col.sortValue(a) : "";
    const bv = col.sortValue ? col.sortValue(b) : "";
    let cmp;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === "desc" ? -cmp : cmp;
  });

  const thead = columns
    .map((c) => {
      if (!c.sortable) return `<th>${escapeHtml(c.label)}</th>`;
      const isActive = c.key === sortKey;
      const nextDir = isActive && sortDir === "asc" ? "desc" : "asc";
      const indicator = isActive ? `<span class="sort-indicator">${sortDir === "asc" ? "▲" : "▼"}</span>` : "";
      return `<th><button type="button" class="sort-btn" data-sort="${c.key}" data-dir="${nextDir}">${escapeHtml(
        c.label
      )}${indicator}</button></th>`;
    })
    .join("");

  const tbody = sorted
    .map((row) => {
      const href = opts.rowHref ? opts.rowHref(row) : null;
      const cells = columns.map((c) => `<td>${c.render(row)}</td>`).join("");
      return `<tr${href ? ` class="clickable-row" data-href="${href}"` : ""}>${cells}</tr>`;
    })
    .join("");

  const table = document.createElement("div");
  table.className = "table-scroll";
  table.innerHTML = `<table><thead><tr>${thead}</tr></thead><tbody>${
    tbody || `<tr><td colspan="${columns.length}" class="empty">No results match these filters.</td></tr>`
  }</tbody></table>`;
  container.appendChild(table);

  table.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setQuery(basePath, { sort: btn.dataset.sort, dir: btn.dataset.dir });
    });
  });

  if (opts.rowHref) {
    table.querySelectorAll("tr.clickable-row").forEach((tr) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return; // let inner links behave normally
        navigate(tr.dataset.href);
      });
    });
  }

  return sorted.length;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------
// Sessions list
// ---------------------------------------------------------------------

function renderSessionsPage(params) {
  const q = (params.get("q") || "").trim().toLowerCase();
  const day = params.get("day") || "";
  const room = params.get("room") || "";
  const status = params.get("status") || "";
  const video = params.get("video") || "";
  const kind = params.get("kind") || "";

  const days = uniqueSorted(MODEL.sessions.map((s) => s.dayKey).filter(Boolean));
  const rooms = uniqueSorted(MODEL.sessions.map((s) => s.room).filter(Boolean));
  const statuses = uniqueSorted(MODEL.sessions.map((s) => s.status).filter(Boolean));

  let rows = MODEL.sessions;
  if (day) rows = rows.filter((s) => s.dayKey === day);
  if (room) rows = rows.filter((s) => s.room === room);
  if (status) rows = rows.filter((s) => s.status === status);
  if (video === "yes") rows = rows.filter((s) => s.hasVideo);
  if (video === "no") rows = rows.filter((s) => !s.hasVideo);
  if (kind === "service") rows = rows.filter((s) => s.isServiceSession);
  if (kind === "plenum") rows = rows.filter((s) => s.isPlenumSession);
  if (kind === "talk") rows = rows.filter((s) => !s.isServiceSession && !s.isPlenumSession);
  if (q) {
    rows = rows.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.speakers.some((sp) => sp.toLowerCase().includes(q)) ||
        s.room.toLowerCase().includes(q)
    );
  }

  app.innerHTML = "";
  const h = document.createElement("div");
  h.innerHTML = `
    <div class="page-title"><h1>Sessions</h1><span class="count">${MODEL.sessions.length} total</span></div>
    <p class="muted">KCDC 2026 runs September&nbsp;9&ndash;11, 2026 in Kansas City.</p>
  `;
  app.appendChild(h);

  const filters = document.createElement("div");
  filters.className = "filters";
  filters.innerHTML = `
    <label>Search
      <input type="search" id="f-q" placeholder="title, speaker, room&hellip;" value="${escapeAttr(q)}">
    </label>
    <label>Day
      <select id="f-day">
        <option value="">All days</option>
        ${days.map((d) => `<option value="${d}" ${d === day ? "selected" : ""}>${formatDayOption(d)}</option>`).join("")}
      </select>
    </label>
    <label>Room
      <select id="f-room">
        <option value="">All rooms</option>
        ${rooms.map((r) => `<option value="${escapeAttr(r)}" ${r === room ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
      </select>
    </label>
    <label>Status
      <select id="f-status">
        <option value="">All statuses</option>
        ${statuses
          .map((st) => `<option value="${escapeAttr(st)}" ${st === status ? "selected" : ""}>${escapeHtml(st)}</option>`)
          .join("")}
      </select>
    </label>
    <label>Type
      <select id="f-kind">
        <option value="">All types</option>
        <option value="talk" ${kind === "talk" ? "selected" : ""}>Talks</option>
        <option value="service" ${kind === "service" ? "selected" : ""}>Service sessions</option>
        <option value="plenum" ${kind === "plenum" ? "selected" : ""}>Plenum</option>
      </select>
    </label>
    <label>Video
      <select id="f-video">
        <option value="">Any</option>
        <option value="yes" ${video === "yes" ? "selected" : ""}>Has a match</option>
        <option value="no" ${video === "no" ? "selected" : ""}>No match</option>
      </select>
    </label>
    <a href="#/sessions" class="clear-link">Clear filters</a>
  `;
  app.appendChild(filters);

  filters.querySelector("#f-q").addEventListener(
    "input",
    debounce((e) => setQuery("/sessions", { q: e.target.value }), 200)
  );
  filters.querySelector("#f-day").addEventListener("change", (e) => setQuery("/sessions", { day: e.target.value }));
  filters.querySelector("#f-room").addEventListener("change", (e) => setQuery("/sessions", { room: e.target.value }));
  filters.querySelector("#f-status").addEventListener("change", (e) => setQuery("/sessions", { status: e.target.value }));
  filters.querySelector("#f-kind").addEventListener("change", (e) => setQuery("/sessions", { kind: e.target.value }));
  filters.querySelector("#f-video").addEventListener("change", (e) => setQuery("/sessions", { video: e.target.value }));

  const columns = [
    {
      key: "startsAt",
      label: "Starts",
      sortable: true,
      sortValue: (s) => s.startsAt || "",
      render: (s) => (s.startsAt ? `${formatDayShort(s.dayKey)} ${formatTime(s.startsAt)}` : "&mdash;"),
    },
    {
      key: "title",
      label: "Title",
      sortable: true,
      sortValue: (s) => s.title,
      render: (s) => `<a href="#/sessions/${encodeURIComponent(s.id)}">${escapeHtml(s.title)}</a>`,
    },
    {
      key: "speakers",
      label: "Speakers",
      sortable: true,
      sortValue: (s) => s.speakers.join(", "),
      render: (s) => speakerLinksHtml(s.speakers),
    },
    { key: "room", label: "Room", sortable: true, sortValue: (s) => s.room, render: (s) => escapeHtml(s.room) },
    { key: "status", label: "Status", sortable: true, sortValue: (s) => s.status, render: (s) => escapeHtml(s.status) },
    {
      key: "hasVideo",
      label: "Video",
      sortable: true,
      sortValue: (s) => (s.hasVideo ? 1 : 0),
      render: (s) => (s.hasVideo ? `<span class="pill">${s.matches.length} match${s.matches.length > 1 ? "es" : ""}</span>` : `<span class="pill dim">none</span>`),
    },
  ];

  const resultCount = renderTable(app, {
    basePath: "/sessions",
    params,
    columns,
    rows,
    defaultSort: "startsAt",
    defaultDir: "asc",
    rowHref: (s) => `#/sessions/${encodeURIComponent(s.id)}`,
  });

  appendResultSummary(app, resultCount, rows.length !== MODEL.sessions.length);
}

function formatDayOption(dayKey) {
  return formatDayShort(dayKey);
}

// ---------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------

function renderSessionDetail(id) {
  const s = MODEL.sessionById.get(decodeURIComponent(id));
  app.innerHTML = "";
  if (!s) {
    app.innerHTML = `<a class="back-link" href="#/sessions">&larr; All sessions</a><p class="error">Session "${escapeHtml(
      id
    )}" wasn't found.</p>`;
    return;
  }

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <a class="back-link" href="#/sessions">&larr; All sessions</a>
    <h1>${escapeHtml(s.title)}</h1>
    <div class="detail-meta">
      <span>${s.startsAt ? formatDayLong(s.dayKey) : "Time TBD"}</span>
      <span>${s.startsAt ? `${formatTime(s.startsAt)}&ndash;${formatTime(s.endsAt)}` : ""}</span>
      <span>Room ${escapeHtml(s.room || "TBD")}</span>
      <span class="pill">${escapeHtml(s.status || "Unknown")}</span>
      ${s.isServiceSession ? '<span class="pill dim">Service session</span>' : ""}
      ${s.isPlenumSession ? '<span class="pill dim">Plenum</span>' : ""}
    </div>
    <div class="detail-card">
      <strong>Speakers:</strong>
      <div class="tag-list speaker-links">${speakerLinksHtml(s.speakers)}</div>
    </div>
    <div class="detail-desc">${escapeHtml(s.description) || "<em>No description provided.</em>"}</div>
    <h2>Video matches</h2>
    ${renderMatchList(s.matches, { showSpeaker: true })}
  `;
  app.appendChild(wrap);
}

function renderMatchList(matches, { showSpeaker = false } = {}) {
  if (!matches.length) {
    return `<p class="muted">No YouTube match found yet for this ${showSpeaker ? "session" : "speaker's talk"}.</p>`;
  }
  return matches
    .map(
      (m) => `
    <div class="match-card">
      <div class="video-title"><a href="${escapeAttr(m.youtubeUrl)}" target="_blank" rel="noopener">${escapeHtml(
        m.videoTitle || m.youtubeUrl
      )}</a></div>
      <div class="match-meta">
        ${showSpeaker ? `${speakerLinksHtml([m.speaker])} &middot; ` : ""}${escapeHtml(m.channel || "")}
        &middot; <span class="pill">${escapeHtml(m.matchType || "")}</span>
        &middot; <span class="pill">${escapeHtml(m.matchConfidence || "")} confidence</span>
      </div>
      ${m.notes ? `<div class="match-notes muted">${escapeHtml(m.notes)}</div>` : ""}
    </div>`
    )
    .join("");
}

function speakerLinksHtml(names) {
  if (!names.length) return '<span class="muted">&mdash;</span>';
  return names
    .map((n) => `<a href="#/speakers/${encodeURIComponent(n)}">${escapeHtml(n)}</a>`)
    .join(", ");
}

// ---------------------------------------------------------------------
// Speakers list
// ---------------------------------------------------------------------

function renderSpeakersPage(params) {
  const q = (params.get("q") || "").trim().toLowerCase();
  const video = params.get("video") || "";

  let rows = MODEL.speakers;
  if (video === "yes") rows = rows.filter((s) => s.hasMatch);
  if (video === "no") rows = rows.filter((s) => !s.hasMatch);
  if (q) rows = rows.filter((s) => s.name.toLowerCase().includes(q));

  app.innerHTML = "";
  const h = document.createElement("div");
  h.innerHTML = `<div class="page-title"><h1>Speakers</h1><span class="count">${MODEL.speakers.length} total</span></div>`;
  app.appendChild(h);

  const filters = document.createElement("div");
  filters.className = "filters";
  filters.innerHTML = `
    <label>Search
      <input type="search" id="f-q" placeholder="speaker name&hellip;" value="${escapeAttr(q)}">
    </label>
    <label>Video
      <select id="f-video">
        <option value="">Any</option>
        <option value="yes" ${video === "yes" ? "selected" : ""}>Has a match</option>
        <option value="no" ${video === "no" ? "selected" : ""}>No match</option>
      </select>
    </label>
    <a href="#/speakers" class="clear-link">Clear filters</a>
  `;
  app.appendChild(filters);

  filters.querySelector("#f-q").addEventListener(
    "input",
    debounce((e) => setQuery("/speakers", { q: e.target.value }), 200)
  );
  filters.querySelector("#f-video").addEventListener("change", (e) => setQuery("/speakers", { video: e.target.value }));

  const columns = [
    {
      key: "name",
      label: "Name",
      sortable: true,
      sortValue: (s) => s.name,
      render: (s) => `<a href="#/speakers/${s.slug}">${escapeHtml(s.name)}</a>`,
    },
    {
      key: "sessions",
      label: "Sessions",
      sortable: true,
      sortValue: (s) => s.sessions.length,
      render: (s) => sessionLinksHtml(s.sessions),
    },
    {
      key: "matches",
      label: "Video matches",
      sortable: true,
      sortValue: (s) => s.matches.length,
      render: (s) => (s.matches.length ? `<span class="pill">${s.matches.length}</span>` : `<span class="pill dim">0</span>`),
    },
  ];

  const resultCount = renderTable(app, {
    basePath: "/speakers",
    params,
    columns,
    rows,
    defaultSort: "name",
    defaultDir: "asc",
    rowHref: (s) => `#/speakers/${s.slug}`,
  });

  appendResultSummary(app, resultCount, rows.length !== MODEL.speakers.length);
}

function sessionLinksHtml(sessions) {
  if (!sessions.length) return '<span class="muted">&mdash;</span>';
  return `<div class="tag-list session-links">${sessions
    .map((s) => `<a href="#/sessions/${encodeURIComponent(s.id)}">${escapeHtml(s.title)}</a>`)
    .join("<br>")}</div>`;
}

// ---------------------------------------------------------------------
// Speaker detail
// ---------------------------------------------------------------------

function renderSpeakerDetail(name) {
  const speaker = MODEL.speakerByName.get(name);
  app.innerHTML = "";
  if (!speaker) {
    app.innerHTML = `<a class="back-link" href="#/speakers">&larr; All speakers</a><p class="error">Speaker "${escapeHtml(
      name
    )}" wasn't found.</p>`;
    return;
  }

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <a class="back-link" href="#/speakers">&larr; All speakers</a>
    <h1>${escapeHtml(speaker.name)}</h1>
    <h2>Sessions</h2>
    ${
      speaker.sessions.length
        ? `<div class="table-scroll"><table><tbody>${speaker.sessions
            .map(
              (s) => `<tr><td><a href="#/sessions/${encodeURIComponent(s.id)}">${escapeHtml(s.title)}</a></td>
              <td class="muted">${s.startsAt ? `${formatDayShort(s.dayKey)} ${formatTime(s.startsAt)}` : ""}</td>
              <td class="muted">${escapeHtml(s.room)}</td></tr>`
            )
            .join("")}</tbody></table></div>`
        : '<p class="muted">No sessions found for this speaker.</p>'
    }
    <h2>Video matches</h2>
    ${renderMatchList(speaker.matches)}
    ${
      !speaker.matches.length && speaker.searchedNoMatch
        ? '<p class="muted">Searched, but no confident YouTube match was found for this speaker yet.</p>'
        : ""
    }
  `;
  app.appendChild(wrap);
}

// ---------------------------------------------------------------------
// Videos list
// ---------------------------------------------------------------------

function renderVideosPage(params) {
  const q = (params.get("q") || "").trim().toLowerCase();
  const matchType = params.get("type") || "";
  const confidence = params.get("confidence") || "";

  const types = uniqueSorted(MODEL.matches.map((m) => m.matchType).filter(Boolean));
  const confidences = ["high", "medium", "low"].filter((c) => MODEL.matches.some((m) => m.matchConfidence === c));

  let rows = MODEL.matches;
  if (matchType) rows = rows.filter((m) => m.matchType === matchType);
  if (confidence) rows = rows.filter((m) => m.matchConfidence === confidence);
  if (q) {
    rows = rows.filter(
      (m) =>
        (m.speaker || "").toLowerCase().includes(q) ||
        (m.sessionTitle || "").toLowerCase().includes(q) ||
        (m.videoTitle || "").toLowerCase().includes(q) ||
        (m.channel || "").toLowerCase().includes(q)
    );
  }

  app.innerHTML = "";
  const h = document.createElement("div");
  h.innerHTML = `<div class="page-title"><h1>Videos</h1><span class="count">${MODEL.matches.length} matches</span></div>
    <p class="muted">Inferred matches to prior talks by the same speakers &mdash; a stand-in until real 2026 recordings exist.</p>`;
  app.appendChild(h);

  const filters = document.createElement("div");
  filters.className = "filters";
  filters.innerHTML = `
    <label>Search
      <input type="search" id="f-q" placeholder="speaker, title, channel&hellip;" value="${escapeAttr(q)}">
    </label>
    <label>Match type
      <select id="f-type">
        <option value="">All types</option>
        ${types.map((t) => `<option value="${escapeAttr(t)}" ${t === matchType ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
      </select>
    </label>
    <label>Confidence
      <select id="f-conf">
        <option value="">Any</option>
        ${confidences
          .map((c) => `<option value="${c}" ${c === confidence ? "selected" : ""}>${escapeHtml(c)}</option>`)
          .join("")}
      </select>
    </label>
    <a href="#/videos" class="clear-link">Clear filters</a>
  `;
  app.appendChild(filters);

  filters.querySelector("#f-q").addEventListener(
    "input",
    debounce((e) => setQuery("/videos", { q: e.target.value }), 200)
  );
  filters.querySelector("#f-type").addEventListener("change", (e) => setQuery("/videos", { type: e.target.value }));
  filters.querySelector("#f-conf").addEventListener("change", (e) => setQuery("/videos", { confidence: e.target.value }));

  const columns = [
    {
      key: "speaker",
      label: "Speaker",
      sortable: true,
      sortValue: (m) => m.speaker || "",
      render: (m) => speakerLinksHtml([m.speaker]),
    },
    {
      key: "sessionTitle",
      label: "Session",
      sortable: true,
      sortValue: (m) => m.sessionTitle || "",
      render: (m) => (MODEL.sessionById.has(m.sessionId)
        ? `<a href="#/sessions/${encodeURIComponent(m.sessionId)}">${escapeHtml(m.sessionTitle || "")}</a>`
        : escapeHtml(m.sessionTitle || "")),
    },
    {
      key: "videoTitle",
      label: "Video",
      sortable: true,
      sortValue: (m) => m.videoTitle || "",
      render: (m) => `<a href="${escapeAttr(m.youtubeUrl)}" target="_blank" rel="noopener">${escapeHtml(m.videoTitle || m.youtubeUrl)}</a>`,
    },
    { key: "channel", label: "Channel", sortable: true, sortValue: (m) => m.channel || "", render: (m) => escapeHtml(m.channel || "") },
    {
      key: "matchType",
      label: "Match type",
      sortable: true,
      sortValue: (m) => m.matchType || "",
      render: (m) => `<span class="pill">${escapeHtml(m.matchType || "")}</span>`,
    },
    {
      key: "matchConfidence",
      label: "Confidence",
      sortable: true,
      sortValue: (m) => ({ high: 3, medium: 2, low: 1 }[m.matchConfidence] || 0),
      render: (m) => escapeHtml(m.matchConfidence || ""),
    },
  ];

  const resultCount = renderTable(app, {
    basePath: "/videos",
    params,
    columns,
    rows,
    defaultSort: "speaker",
    defaultDir: "asc",
  });

  appendResultSummary(app, resultCount, rows.length !== MODEL.matches.length);
}

// ---------------------------------------------------------------------
// Explore (datasette-lite)
// ---------------------------------------------------------------------

function renderExplorePage() {
  const dbUrl = new URL(DB_PATH, location.href).href;
  const liteUrl = `https://lite.datasette.io/?url=${encodeURIComponent(dbUrl)}`;
  const dbName = "kcdc";

  app.innerHTML = `
    <div class="page-title"><h1>Explore the database</h1></div>
    <p>This site is backed by a SQLite database (<code>kcdc.db</code>) with the same sessions,
    speakers, and video-match data as the tables above, normalized into a few relational tables.
    <a href="https://github.com/simonw/datasette-lite" target="_blank" rel="noopener">datasette-lite</a>
    runs a full <a href="https://datasette.io/" target="_blank" rel="noopener">Datasette</a> instance
    entirely in your browser (via Pyodide/WebAssembly) and can load this database straight from its URL &mdash;
    no server, no upload.</p>

    <div class="explore-actions">
      <a class="btn" href="${escapeAttr(liteUrl)}" target="_blank" rel="noopener">Open in datasette-lite &#8599;</a>
      <a class="btn secondary" href="${escapeAttr(dbUrl)}">Download kcdc.db</a>
    </div>

    <h2>Jump straight to a table</h2>
    <div class="query-links">
      ${["sessions", "speakers", "session_speakers", "youtube_matches", "unmatched_speakers"]
        .map((t) => {
          const url = `https://lite.datasette.io/?url=${encodeURIComponent(dbUrl)}#/${dbName}/${t}`;
          return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${dbName}/${t}</a>`;
        })
        .join("")}
    </div>

    <h2>Example query</h2>
    <p class="muted">Sessions with a high-confidence video match, newest speaker match first:</p>
    <code class="code-block">SELECT s.title, sp.name AS speaker, y.video_title, y.match_confidence
FROM sessions s
JOIN session_speakers ss ON ss.session_id = s.id
JOIN speakers sp ON sp.id = ss.speaker_id
JOIN youtube_matches y ON y.session_id = s.id AND y.speaker_id = sp.id
WHERE y.match_confidence = 'high'
ORDER BY s.starts_at;</code>
    <a class="btn secondary" href="${escapeAttr(
      `https://lite.datasette.io/?url=${encodeURIComponent(dbUrl)}#/${dbName}?sql=` +
        encodeURIComponent(
          `SELECT s.title, sp.name AS speaker, y.video_title, y.match_confidence\nFROM sessions s\nJOIN session_speakers ss ON ss.session_id = s.id\nJOIN speakers sp ON sp.id = ss.speaker_id\nJOIN youtube_matches y ON y.session_id = s.id AND y.speaker_id = sp.id\nWHERE y.match_confidence = 'high'\nORDER BY s.starts_at;`
        )
    )}" target="_blank" rel="noopener">Run this query in datasette-lite &#8599;</a>

    <h2>Embedded</h2>
    <p class="muted">Loads a full Python runtime (Pyodide/WebAssembly) in your browser, so it's a multi-MB download
    and can take a while &mdash; not started automatically. Click below when you want it.</p>
    <button type="button" class="btn secondary" id="load-embedded">Load embedded explorer</button>
    <div id="embedded-explorer-slot"></div>
  `;

  document.getElementById("load-embedded").addEventListener("click", (e) => {
    const slot = document.getElementById("embedded-explorer-slot");
    slot.innerHTML = `<iframe class="explore-frame" src="${escapeAttr(liteUrl)}" title="datasette-lite"></iframe>`;
    e.target.remove();
  });
}

// ---------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------

function renderNotFound(raw) {
  app.innerHTML = `<p class="error">No route for "#${escapeHtml(raw)}".</p><p><a href="#/sessions">Go to sessions &rarr;</a></p>`;
}

// ---------------------------------------------------------------------
// Formatting / small utils
// ---------------------------------------------------------------------

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function appendResultSummary(container, shown, isFiltered) {
  if (!isFiltered) return;
  const p = document.createElement("p");
  p.className = "muted";
  p.style.marginTop = "0.6rem";
  p.textContent = `Showing ${shown} result${shown === 1 ? "" : "s"} for the current filters.`;
  container.appendChild(p);
}

const DAY_NAMES = { "2026-09-09": "Wed, Sep 9", "2026-09-10": "Thu, Sep 10", "2026-09-11": "Fri, Sep 11" };

function formatDayShort(dayKey) {
  return DAY_NAMES[dayKey] || dayKey;
}

function formatDayLong(dayKey) {
  if (!dayKey) return "";
  try {
    const d = new Date(dayKey + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch (e) {
    return dayKey;
  }
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
