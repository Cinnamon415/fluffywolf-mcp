// Agents, window bindings, rights and the per-agent tab allow-list.
//
// Every MCP server process is one "agent" with its own WebSocket. An agent can do nothing until the user picks it
// in the popup of a window (a "binding", time-limited). Inside a bound window it sees only the tabs the user
// allowed for it, unless the user gave it full access. All of this is enforced here, never in the MCP server.
/* global browser, fetch, AbortController, FWMCP_CONFIG, commands, siteOf, sameSite, cleanText, Notices, rightsText, shortDir,
   refreshPageActions, tabMeta */

const DEFAULT_MINUTES = 15;
const MAX_MINUTES = 1440;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const PORT_SPAN = FWMCP_CONFIG.span || 10;
const DEFAULT_RIGHTS = { newTabs: false, crossDomain: false, full: false };

const state = { defaultMinutes: DEFAULT_MINUTES };
// Identity of this browser profile. Every profile runs its own copy of the extension with its own storage, so
// profiles share nothing; the MCP server tells them apart by this id.
let profile = null;         // { id, label }
const agents = new Map();   // connId -> live agent
const bindings = new Map(); // windowId -> { connId, expiresAt, windowMs, wasActive }
const allow = new Map();    // tabId -> Map(recordId -> { site, url, own })
const sockets = new Map();  // port -> WebSocket
let records = {};           // recordId -> { id, name, created, lastSeen, rights }; kept a week after the agent leaves

const live = (b) => Date.now() < b.expiresAt;
const label = (agent) => `#${agent.connId.slice(-4)}`;

function clampMinutes(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) throw new Error("minutes must be a whole number of at least 1");
  return Math.min(n, MAX_MINUTES);
}

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- records and allow-list persistence ----------

let saveTimer = null;
function saveRecords() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { browser.storage.local.set({ records }).catch(() => {}); }, 300);
}

function pruneRecords() {
  let changed = false;
  for (const [id, r] of Object.entries(records)) {
    if (agentsOfRecord(id).length) continue;
    if (Date.now() - (r.lastSeen || 0) > WEEK_MS) { delete records[id]; changed = true; }
  }
  if (changed) saveRecords();
}

// Allowed tabs are also stored as a session value on the tab itself, which survives a browser restart
// (tab ids do not).
function persistTab(tabId) {
  try {
    const m = allow.get(tabId);
    const p = m && m.size ? browser.sessions.setTabValue(tabId, "fwmcp", Object.fromEntries(m)) : browser.sessions.removeTabValue(tabId, "fwmcp");
    p.catch(() => {});
  } catch {}
}

async function hydrateTab(tabId) {
  try {
    const v = await browser.sessions.getTabValue(tabId, "fwmcp");
    if (!v || typeof v !== "object") return;
    const m = allow.get(tabId) || new Map();
    for (const [rid, e] of Object.entries(v)) {
      if (!m.has(rid) && e && typeof e.site === "string") m.set(rid, { site: e.site, url: String(e.url || ""), own: !!e.own });
    }
    if (m.size) allow.set(tabId, m);
  } catch {}
}

function allowTab(rid, tab, own = false) {
  const m = allow.get(tab.id) || new Map();
  const entry = { site: siteOf(tab.url), url: tab.url, own };
  m.set(rid, entry);
  allow.set(tab.id, m);
  persistTab(tab.id);
  return entry;
}

function disallowTab(rid, tabId) {
  const m = allow.get(tabId);
  if (!m || !m.delete(rid)) return false;
  if (!m.size) allow.delete(tabId);
  persistTab(tabId);
  return true;
}

const entryOf = (rid, tabId) => allow.get(tabId)?.get(rid) || null;

function countAllowed(rid) {
  let n = 0;
  for (const m of allow.values()) if (m.has(rid)) n++;
  return n;
}

// ---------- agent / binding lookups ----------

const recordOf = (agent) => (agent.recordId && records[agent.recordId]) || null;
const agentsOfRecord = (rid) => [...agents.values()].filter((a) => a.recordId === rid);
const boundWindows = (agent) => [...bindings].filter(([, b]) => b.connId === agent.connId).map(([w]) => w);
const activeWindows = (agent) => [...bindings].filter(([, b]) => b.connId === agent.connId && live(b)).map(([w]) => w);

function agentForWindow(windowId, onlyActive = false) {
  const b = bindings.get(windowId);
  const a = b && agents.get(b.connId);
  return a && (!onlyActive || live(b)) ? a : null;
}

function agentState(agent) {
  if (!boundWindows(agent).length) return "unbound";
  return activeWindows(agent).length ? "active" : "paused";
}

function statusOf(agent) {
  const rec = recordOf(agent);
  return {
    state: agentState(agent),
    name: agent.name,
    label: label(agent),
    windows: [...bindings].filter(([, b]) => b.connId === agent.connId)
      .map(([w, b]) => ({ windowId: w, active: live(b), secondsLeft: Math.max(0, Math.round((b.expiresAt - Date.now()) / 1000)) })),
    rights: rec ? rightsText(rec.rights, countAllowed(rec.id)) : null,
    resumeId: rec ? rec.id : null,
    kicked: agent.kicked || null,
  };
}

function pushState(agent) {
  try { agent.ws.send(JSON.stringify({ type: "state", status: statusOf(agent) })); } catch {}
}

function notify(agent, key, text) {
  agent.notices.push(key, text);
}

// ---------- access checks used by every command ----------

function requireAccess(agent) {
  if (agent.kicked) throw new Error(agent.kicked);
  if (!agent.name) {
    throw new Error("You have not identified yourself. Call request_access with a short name of your own (and what you want to do) so the user can recognise you in the FluffyWolf MCP popup.");
  }
  if (activeWindows(agent).length) return;
  if (boundWindows(agent).length) {
    throw new Error("Your access is paused: the time the user granted ran out or was revoked. Ask the user to allow it again in the FluffyWolf MCP popup (call request_access to wait for that).");
  }
  throw new Error("You have no access to any browser window yet. Call request_access; the user has to pick this session in the FluffyWolf MCP popup.");
}

// Throws unless the agent may act on this tab right now. Returns the allow entry (null with full access).
function authorizeTab(agent, tab) {
  const rec = recordOf(agent);
  if (!activeWindows(agent).includes(tab.windowId)) {
    throw new Error(`Tab ${tab.id} is not in a window the user shared with you.`);
  }
  if (rec.rights.full) { agent.touched.add(tab.id); return null; }
  const entry = entryOf(rec.id, tab.id);
  if (!entry) {
    throw new Error(`Tab ${tab.id} is not allowed for you. The user can allow it with the FluffyWolf MCP button in the address bar while that tab is open.`);
  }
  if (!rec.rights.crossDomain && !sameSite(entry.site, tab.url)) {
    revokeTab(rec, tab.id, `moved to another site than ${entry.site}`);
    throw new Error(`Tab ${tab.id} moved to another site, so your access to it was revoked (cross-domain navigation is not granted).`);
  }
  agent.touched.add(tab.id);
  return entry;
}

// Removes a tab from the agent's list and tells every live agent that uses this record.
function revokeTab(rec, tabId, why) {
  if (!disallowTab(rec.id, tabId)) return;
  const title = tabMeta.get(tabId)?.title || "";
  for (const a of agentsOfRecord(rec.id)) {
    notify(a, `drop:${tabId}`, `Your access to tab ${tabId}${title ? ` ("${title}")` : ""} was revoked: it ${why}.`);
  }
  refreshPageActions();
}

// Tabs the agent can see: every tab of its active windows with full access, else the allowed ones.
async function visibleTabs(agent) {
  const rec = recordOf(agent);
  const all = [];
  for (const w of activeWindows(agent)) {
    try { all.push(...(await browser.tabs.query({ windowId: w }))); } catch {}
  }
  if (rec.rights.full) return all.map((tab) => ({ tab, entry: null }));
  const out = [];
  for (const tab of all) {
    const entry = entryOf(rec.id, tab.id);
    if (!entry) continue;
    if (!rec.rights.crossDomain && !sameSite(entry.site, tab.url)) { revokeTab(rec, tab.id, `moved to another site than ${entry.site}`); continue; }
    out.push({ tab, entry });
  }
  return out;
}

// ---------- agent lifecycle ----------

function registerAgent(ws, info) {
  if (typeof info.agentId !== "string" || !/^[0-9a-f]{32}$/.test(info.agentId)) return null;
  const agent = {
    connId: info.agentId, ws,
    cwd: "", pid: 0, // filled in by request_access: until then this profile knows nothing about the agent
    name: null, purpose: "", requestedAt: 0, resume: null, recordId: null, kicked: null,
    notices: new Notices(), touched: new Set(), current: null, busyUntil: 0, closing: null,
  };
  agents.set(agent.connId, agent);
  return agent;
}

// The user ended the agent's last window: it stops being a requester at once (no entry in the popup, no badge)
// and its next call explains why. It has to call request_access again to be listed.
function evict(agent, text) {
  agent.notices.drain();
  agent.kicked = `${text} You are no longer connected to this browser profile and the user does not see a request from you. Call request_access again only if you still need the browser and the user agrees.`;
  agent.name = null;
  agent.purpose = "";
  agent.requestedAt = 0;
  agent.resume = null;
  agent.current = null;
  agent.touched.clear();
  pushState(agent);
}

function dropAgent(agent) {
  agents.delete(agent.connId);
  for (const w of boundWindows(agent)) bindings.delete(w);
  const rec = recordOf(agent);
  if (rec) { rec.lastSeen = Date.now(); saveRecords(); }
  pruneRecords();
  refreshChrome();
}

function ensureRecord(agent) {
  let rec = recordOf(agent);
  if (!rec) {
    const claimed = agent.resume && records[agent.resume] && !agentsOfRecord(agent.resume).length ? agent.resume : null;
    const id = claimed || newId();
    rec = records[id] || (records[id] = { id, created: Date.now(), rights: { ...DEFAULT_RIGHTS } });
    agent.recordId = id;
  }
  rec.name = agent.name;
  rec.lastSeen = Date.now();
  saveRecords();
  return rec;
}

function requestAccess(agent, args) {
  const name = cleanText(args.name, 40);
  if (!name) throw new Error("name is required: a short name of your own so the user can tell agents apart");
  agent.kicked = null;
  agent.name = name;
  agent.purpose = cleanText(args.purpose, 160);
  // cwd and pid are supplied by the MCP server process itself, not by the model.
  agent.cwd = cleanText(args.cwd, 200);
  agent.pid = Number.isInteger(args.pid) ? args.pid : 0;
  // The agent passes the ids it was given in every profile; this profile recognises only its own.
  const ids = Array.isArray(args.resume) ? args.resume : [];
  agent.resume = ids.find((id) => typeof id === "string" && records[id]) || null;
  agent.requestedAt = Date.now();
  refreshChrome();
  return statusOf(agent);
}

// ---------- commands arriving from the MCP server ----------

async function handleCommand(agent, ws, msg) {
  const reply = (body) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, ...body, notices: agent.notices.drain() }));
  };
  try {
    let result;
    if (msg.cmd === "request_access") result = requestAccess(agent, msg.args || {});
    else if (msg.cmd === "status") result = statusOf(agent);
    else {
      // Checked on every command with the real clock, so a late timer can never extend access.
      requireAccess(agent);
      const handler = commands[msg.cmd];
      if (!handler) throw new Error(`unknown command: ${msg.cmd}`);
      agent.busyUntil = Infinity;
      try { result = await handler(msg.args || {}, agent); } finally { agent.busyUntil = Date.now() + 1500; }
    }
    reply({ ok: true, result });
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e) });
  }
}

// ---------- WebSocket to the MCP servers: one socket per server, ports base..base+span-1 ----------

function connectPort(port) {
  if (sockets.has(port)) return;
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/`); } catch { return; }
  sockets.set(port, ws);
  let agent = null;
  ws.onopen = () => ws.send(JSON.stringify({
    type: "hello", token: FWMCP_CONFIG.token, version: browser.runtime.getManifest().version,
    profileId: profile.id, profile: profile.label,
  }));
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    if (msg.type === "agent") {
      agent = registerAgent(ws, msg);
      if (!agent) ws.close();
      return;
    }
    if (agent && typeof msg.id === "number") await handleCommand(agent, ws, msg);
  };
  ws.onclose = () => {
    if (sockets.get(port) === ws) sockets.delete(port);
    if (agent) dropAgent(agent);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// A WebSocket that fails to connect is remembered by the browser per address, and the next attempt to it is delayed,
// by up to a minute (RFC 6455 7.2.3). Trying every port every few seconds would make a server that starts later wait
// that long, so each port is probed with a plain HTTP request first, which carries no such penalty.
const probing = new Set();
async function probe(port) {
  if (sockets.has(port) || probing.has(port)) return;
  probing.add(port);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    connectPort(port);
  } catch {
    // nothing listens on this port (yet)
  } finally {
    clearTimeout(timer);
    probing.delete(port);
  }
}

function scanPorts() {
  if (!profile) return;
  for (let p = FWMCP_CONFIG.port; p < FWMCP_CONFIG.port + PORT_SPAN; p++) probe(p);
}

// ---------- user actions (from the popup, and the address-bar button in events.js) ----------

function bind(windowId, connId, minutes) {
  const agent = agents.get(connId);
  if (!agent || !agent.name) throw new Error("This agent is no longer asking for access.");
  const prev = bindings.get(windowId);
  if (prev && prev.connId !== connId) {
    const old = agents.get(prev.connId);
    if (old) {
      if (boundWindows(old).length > 1) { notify(old, `win:${windowId}`, `The user took window ${windowId} away from you.`); pushState(old); }
      else { bindings.delete(windowId); evict(old, `The user took window ${windowId} away from you and gave it to another agent.`); }
    }
  }
  const rec = ensureRecord(agent);
  const ms = (minutes == null ? state.defaultMinutes : clampMinutes(minutes)) * 60000;
  bindings.set(windowId, { connId, expiresAt: Date.now() + ms, windowMs: ms, wasActive: true });
  notify(agent, "access", `The user gave you access to window ${windowId}. ${rightsText(rec.rights, countAllowed(rec.id))} `
    + `Your resume id (pass it as 'resume' to request_access after a reconnect to get your tab list back): ${rec.id}`);
  pushState(agent);
  refreshChrome();
}

function unbind(windowId) {
  const b = bindings.get(windowId);
  if (!b) return;
  bindings.delete(windowId);
  const agent = agents.get(b.connId);
  if (agent) {
    if (boundWindows(agent).length) { notify(agent, `win:${windowId}`, `The user ended your access to window ${windowId}.`); pushState(agent); }
    else evict(agent, `The user ended your access to window ${windowId} and removed you from FluffyWolf MCP.`);
  }
  refreshChrome();
}

function bindingFor(windowId) {
  const b = bindings.get(windowId);
  const agent = b && agents.get(b.connId);
  if (!agent) throw new Error("No agent is attached to this window.");
  return { b, agent };
}

function grant(windowId, minutes) {
  const { b, agent } = bindingFor(windowId);
  const ms = (minutes == null ? state.defaultMinutes : clampMinutes(minutes)) * 60000;
  b.windowMs = ms;
  b.expiresAt = Date.now() + ms;
  b.wasActive = true;
  notify(agent, "access", `The user gave you access to window ${windowId} for ${Math.round(ms / 60000)} min.`);
  pushState(agent);
  refreshChrome();
}

function revoke(windowId) {
  const { b, agent } = bindingFor(windowId);
  b.expiresAt = 0;
  b.wasActive = false;
  notify(agent, "access", `The user revoked your access to window ${windowId}; it is paused.`);
  pushState(agent);
  refreshChrome();
}

// Raises the remaining time to the default value; does nothing if there is already at least that much.
function extend(windowId) {
  const { b } = bindingFor(windowId);
  const defMs = state.defaultMinutes * 60000;
  if (!live(b) || b.expiresAt - Date.now() >= defMs) return;
  b.windowMs = defMs;
  b.expiresAt = Date.now() + defMs;
}

function setRights(windowId, wanted) {
  const { agent } = bindingFor(windowId);
  const rec = recordOf(agent);
  const next = { newTabs: !!wanted.newTabs, crossDomain: !!wanted.crossDomain, full: !!wanted.full };
  const changed = Object.keys(next).some((k) => next[k] !== rec.rights[k]);
  if (!changed) return;
  const crossOff = rec.rights.crossDomain && !next.crossDomain;
  rec.rights = next;
  if (crossOff) {
    // Cross-domain was allowed, so tabs may have wandered; pin each one to the site it is on now.
    for (const [tabId, m] of allow) {
      const e = m.get(rec.id);
      const url = tabMeta.get(tabId)?.url;
      if (e && url) { e.site = siteOf(url) || e.site; e.url = url; persistTab(tabId); }
    }
  }
  saveRecords();
  for (const a of agentsOfRecord(rec.id)) {
    notify(a, "rights", `Your rights changed. ${rightsText(rec.rights, countAllowed(rec.id))}`);
    pushState(a);
  }
  refreshPageActions();
}

function untab(windowId, tabId) {
  const { agent } = bindingFor(windowId);
  const rec = recordOf(agent);
  if (disallowTab(rec.id, tabId)) {
    for (const a of agentsOfRecord(rec.id)) notify(a, `allow:${tabId}`, `The user removed your access to tab ${tabId}.`);
    refreshPageActions();
  }
}

// ---------- toolbar badge / icon ----------

async function refreshChrome() {
  const pending = [...agents.values()].filter((a) => a.name && !boundWindows(a).length).length;
  const idle = pending ? String(pending) : "";
  let wins = [];
  try { wins = await browser.windows.getAll(); } catch {}
  browser.browserAction.setBadgeBackgroundColor({ color: "#D97757" });
  browser.browserAction.setBadgeTextColor?.({ color: "#FFFFFF" });
  browser.browserAction.setBadgeText({ text: idle });
  for (const w of wins) {
    const b = bindings.get(w.id);
    const on = !!b && live(b);
    browser.browserAction.setBadgeText({ windowId: w.id, text: on ? "ON" : idle });
    browser.browserAction.setIcon({ windowId: w.id, path: on ? "icons/icon.svg" : "icons/icon-locked.svg" });
  }
  refreshPageActions();
}

// ---------- timers ----------

setInterval(() => {
  let changed = false;
  for (const [w, b] of bindings) {
    if (b.wasActive && !live(b)) {
      b.wasActive = false;
      changed = true;
      const agent = agents.get(b.connId);
      if (agent) { notify(agent, "access", `The time the user granted for window ${w} ran out; access is paused until the user allows it again.`); pushState(agent); }
    }
  }
  for (const a of agents.values()) { const r = recordOf(a); if (r) r.lastSeen = Date.now(); }
  if (changed) refreshChrome();
}, 1000);
setInterval(pruneRecords, 3600 * 1000);
setInterval(scanPorts, 4000);

// ---------- popup API ----------

const labelFor = (a) => ({
  connId: a.connId,
  name: a.name,
  label: label(a),
  purpose: a.purpose,
  dir: shortDir(a.cwd),
  cwd: a.cwd,
  pid: a.pid,
  waitingMs: Date.now() - a.requestedAt,
  elsewhere: boundWindows(a),
  resume: a.resume && records[a.resume] && !agentsOfRecord(a.resume).length
    ? { name: records[a.resume].name, tabs: countAllowed(a.resume) } : null,
});

function viewFor(windowId) {
  const view = { windowId, defaultMinutes: state.defaultMinutes, profileLabel: profile ? profile.label : "", binding: null, candidates: [] };
  const b = bindings.get(windowId);
  const bound = b && agents.get(b.connId);
  if (bound) {
    const rec = recordOf(bound);
    const tabs = [];
    for (const [tabId, m] of allow) {
      const e = m.get(rec.id);
      const meta = tabMeta.get(tabId);
      if (e && meta && meta.windowId === windowId) tabs.push({ id: tabId, title: meta.title || meta.url || String(tabId), own: !!e.own });
    }
    view.binding = {
      agent: labelFor(bound),
      active: live(b),
      expiresAt: b.expiresAt,
      windowMs: b.windowMs,
      rights: { ...rec.rights },
      tabs,
    };
  }
  const names = new Map();
  for (const a of agents.values()) if (a.name) names.set(a.name, (names.get(a.name) || 0) + 1);
  for (const a of agents.values()) {
    if (!a.name || (bound && a.connId === bound.connId)) continue;
    view.candidates.push({ ...labelFor(a), duplicate: names.get(a.name) > 1 });
  }
  if (view.binding) view.binding.agent.duplicate = names.get(bound.name) > 1;
  view.candidates.sort((x, y) => y.waitingMs - x.waitingMs);
  return view;
}

const popupUrl = browser.runtime.getURL("popup.html");

browser.runtime.onMessage.addListener(async (msg, sender) => {
  // Only the extension's own popup may change access; web pages and content scripts cannot.
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(popupUrl) || !msg) return undefined;
  const w = Number.isInteger(msg.windowId) ? msg.windowId : null;
  try {
    switch (msg.type) {
      case "view": break;
      case "bind": bind(w, msg.connId, msg.minutes); break;
      case "unbind": unbind(w); break;
      case "grant": grant(w, msg.minutes); break;
      case "revoke": revoke(w); break;
      case "extend": extend(w); break;
      case "setRights": setRights(w, msg.rights || {}); break;
      case "untab": untab(w, msg.tabId); break;
      case "setProfile": {
        const label = cleanText(msg.label, 40);
        if (!label) throw new Error("Имя профиля не может быть пустым.");
        profile.label = label;
        await browser.storage.local.set({ profile });
        for (const sock of sockets.values()) if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "profile", label }));
        break;
      }
      case "setDefault":
        state.defaultMinutes = clampMinutes(msg.minutes);
        await browser.storage.local.set({ defaultMinutes: state.defaultMinutes });
        break;
      default: return undefined;
    }
    return viewFor(w);
  } catch (e) {
    return { error: String((e && e.message) || e), ...viewFor(w) };
  }
});

// ---------- startup ----------

(async () => {
  try {
    const s = await browser.storage.local.get(["defaultMinutes", "records", "profile"]);
    if (s.defaultMinutes) state.defaultMinutes = clampMinutes(s.defaultMinutes);
    if (s.records && typeof s.records === "object") records = s.records;
    if (s.profile && /^[0-9a-f]{32}$/.test(s.profile.id || "") && cleanText(s.profile.label, 40)) profile = { id: s.profile.id, label: cleanText(s.profile.label, 40) };
  } catch {}
  if (!profile) {
    const id = newId();
    profile = { id, label: `profile-${id.slice(-4)}` };
    try { await browser.storage.local.set({ profile }); } catch {}
  }
  pruneRecords();
  try { for (const t of await browser.tabs.query({})) await hydrateTab(t.id); } catch {}
  refreshChrome();
  scanPorts();
})();
