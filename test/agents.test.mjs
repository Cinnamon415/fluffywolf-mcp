// Runs the extension's background scripts (policy, background, events, gate) against a fake browser,
// WebSocket and clock, with two fake agents.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
let now = 1_000_000;
const intervals = [];

// ---------- fakes ----------

const listeners = () => {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); }, fire: (...a) => ls.slice().forEach((f) => f(...a)) };
};

const sockets = new Map(); // port -> FakeWS
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.port = Number(new URL(url).port); this.readyState = 1; this.sent = []; sockets.set(this.port, this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const T = { onCreated: listeners(), onUpdated: listeners(), onRemoved: listeners(), onActivated: listeners(), onDetached: listeners(), onAttached: listeners() };
let tabs = [];
let nextTab = 100;
const mk = (id, windowId, url, active = false) => ({ id, windowId, url, title: `title ${id}`, active, status: "complete", pinned: false });
const load = (id, url) => {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  t.url = url; t.title = `title ${id}`; t.status = "loading";
  T.onUpdated.fire(id, { url }, { ...t });
  t.status = "complete";
  T.onUpdated.fire(id, { status: "complete" }, { ...t });
};
const tabsApi = {
  query: async (q = {}) => tabs.filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || t.active === q.active)).map((t) => ({ ...t })),
  get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no such tab"); return { ...t }; },
  create: async ({ url, active, windowId }) => {
    const t = mk(nextTab++, windowId, "about:blank", !!active);
    tabs.push(t);
    T.onCreated.fire({ ...t });
    setImmediate(() => load(t.id, url || "about:blank"));
    return { ...t };
  },
  update: async (id, props) => { if (props.url) setImmediate(() => load(id, props.url)); return tabsApi.get(id); },
  remove: async (id) => { const t = tabs.find((x) => x.id === id); tabs = tabs.filter((x) => x.id !== id); T.onRemoved.fire(id, { windowId: t.windowId, isWindowClosing: false }); },
  goBack: async (id) => setImmediate(() => load(id, tabsApi.backUrl)),
  goForward: async () => {}, reload: async (id) => setImmediate(() => load(id, tabs.find((x) => x.id === id).url)),
  sendMessage: async (_id, m) => (m.op === "ping" ? "pong" : { ok: true, op: m.op }),
  executeScript: async () => [],
  captureTab: async () => "data:image/png;base64,AA==",
  ...T,
};

const pa = new Map(); // tabId -> { shown, icon, title }
const paState = (id) => { if (!pa.has(id)) pa.set(id, { shown: false }); return pa.get(id); };
const pageAction = {
  show: async (id) => { paState(id).shown = true; }, hide: async (id) => { paState(id).shown = false; },
  setIcon: async ({ tabId, path }) => { paState(tabId).icon = path; }, setTitle: async ({ tabId, title }) => { paState(tabId).title = title; },
  onClicked: listeners(),
};

const badge = new Map(); // windowId | "global" -> text
let popupHandler;
const onConnect = listeners();
const session = new Map();
const store = {};
const ctx = vm.createContext({
  FWMCP_CONFIG: { port: 8767, span: 10, token: "t" },
  WebSocket: FakeWS, crypto: globalThis.crypto, console, URL,
  Date: { now: () => now },
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  browser: {
    runtime: { id: "x", getURL: (p) => `moz-extension://x/${p}`, getManifest: () => ({ version: "t" }), onMessage: { addListener: (f) => { popupHandler = f; } }, onConnect },
    storage: { local: { get: async () => ({ ...store }), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
    sessions: {
      setTabValue: async (id, k, v) => { session.set(`${id}/${k}`, JSON.parse(JSON.stringify(v))); },
      getTabValue: async (id, k) => session.get(`${id}/${k}`),
      removeTabValue: async (id, k) => { session.delete(`${id}/${k}`); },
    },
    browserAction: {
      setIcon() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {},
      setBadgeText: ({ windowId, text }) => badge.set(windowId ?? "global", text),
    },
    windows: { getAll: async () => [{ id: 1 }, { id: 2 }], getCurrent: async () => ({ id: 1 }), update: async () => {}, onCreated: listeners(), onRemoved: listeners() },
    tabs: tabsApi, pageAction,
  },
});

const resetTabs = () => {
  tabs = [mk(10, 1, "https://example.com/a", true), mk(11, 1, "https://other.org/", false), mk(20, 2, "https://example.com/w2", true)];
  pa.clear();
};
resetTabs();
for (const f of ["policy.js", "background.js", "events.js", "gate.js"]) vm.runInContext(readFileSync(join(ext, f), "utf8"), ctx, { filename: f });
await new Promise((r) => setImmediate(r));
const tick = () => intervals.filter((i) => i.ms === 1000).forEach((i) => i.fn());
const settle = () => new Promise((r) => setImmediate(r));

// ---------- helpers ----------

const A = "a".repeat(32), B = "b".repeat(32);
let nextCmd = 1;
function connect(port, id) {
  const ws = sockets.get(port);
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: "agent", agentId: id }) });
  return ws;
}
async function cmd(ws, name, args = {}) {
  const id = nextCmd++;
  await ws.onmessage({ data: JSON.stringify({ id, cmd: name, args }) });
  const reply = ws.sent.findLast((m) => m.id === id);
  now += 2000; // whatever the user does next happens after the agent's quiet period (1.5 s)
  return reply;
}
// Results come out of the vm context; a JSON round trip gives them host prototypes for deepEqual.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const popup = async (msg, sender = { id: "x", url: "moz-extension://x/popup.html" }) => plain(await popupHandler({ windowId: 1, ...msg }, sender));
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };
const fails = (r, re) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.error, re); };
const noticeText = (r) => (r.notices || []).join("\n");

// ---------- scenario ----------

assert.equal(sockets.size, 10, "extension scans the whole port range");
const wa = connect(8767, A);
const wb = connect(8768, B);

// profile identity: a random id and a default name, sent in the hello; the user can rename the profile
const hello = wa.sent[0];
assert.equal(hello.type, "hello");
assert.match(hello.profileId, /^[0-9a-f]{32}$/);
assert.equal(hello.profile, `profile-${hello.profileId.slice(-4)}`);
assert.equal(store.profile.id, hello.profileId);

// connected agents are invisible to the user until they ask: nothing but an id is known about them
assert.deepEqual((await popup({ type: "view" })).candidates, []);
assert.equal(badge.get("global") ?? "", "");

// nothing works before the agent names itself
fails(await cmd(wa, "list_tabs"), /request_access/);

// request: agent shows up in the popup with its self-chosen name; same names are flagged as duplicates
ok(await cmd(wa, "request_access", { name: "Alpha‮\n", purpose: "check the docs", cwd: "/home/u/projects/alpha", pid: 11 }));
ok(await cmd(wb, "request_access", { name: "Alpha", cwd: "/home/u/projects/beta", pid: 12 }));
let v = await popup({ type: "view" });
assert.equal(v.binding, null);
assert.equal(v.candidates.length, 2);
assert.ok(v.candidates.every((c) => c.duplicate));
assert.equal(v.candidates[0].name, "Alpha");
assert.equal(v.candidates[0].dir, "projects/alpha");
assert.equal(badge.get("global"), "2");

// only the extension's own popup may act
assert.equal(await popup({ type: "bind", connId: A }, { id: "evil", url: "moz-extension://x/popup.html" }), undefined);
assert.equal(await popup({ type: "bind", connId: A }, { id: "x", url: "https://example.com/" }), undefined);
fails(await cmd(wa, "list_tabs"), /no access/i);

// user picks A for window 1: default 15 minutes, restricted rights, nothing allowed yet
v = await popup({ type: "bind", connId: A });
assert.equal(v.binding.agent.connId, A);
assert.equal(v.binding.active, true);
assert.equal(v.binding.expiresAt - now, 15 * 60000);
assert.deepEqual(v.binding.rights, { newTabs: false, crossDomain: false, full: false });
assert.equal(badge.get(1), "ON");
let r = await cmd(wa, "list_tabs");
assert.deepEqual(ok(r), []);
assert.match(noticeText(r), /gave you access to window 1/);
assert.match(noticeText(r), /RESTRICTED/);
assert.match(noticeText(r), /resume id/);
const resumeId = /resume id[^:]*: ([0-9a-f]{32})/.exec(noticeText(r))[1];
fails(await cmd(wa, "snapshot", { tabId: 10 }), /not allowed/);
fails(await cmd(wa, "snapshot"), /No tab is available/);

// address-bar button shows in window 1 only (restricted agent bound there)
await settle();
assert.equal(pa.get(10)?.shown, true);
assert.equal(pa.get(10).icon, "icons/pa-off.svg");
assert.equal(pa.get(20)?.shown ?? false, false);

// user allows tab 10 with the button: the agent sees exactly that tab and hears about it
pageAction.onClicked.fire({ ...tabs[0] });
await settle();
assert.equal(pa.get(10).icon, "icons/pa-on.svg");
r = await cmd(wa, "list_tabs");
assert.deepEqual(ok(r).map((t) => t.id), [10]);
assert.match(noticeText(r), /allowed you to use tab 10/);
ok(await cmd(wa, "snapshot", { tabId: 10 }));
ok(await cmd(wa, "snapshot")); // defaults to the tab used last
fails(await cmd(wa, "snapshot", { tabId: 11 }), /not allowed/);
fails(await cmd(wa, "snapshot", { tabId: 20 }), /not in a window/);
v = await popup({ type: "view" });
assert.deepEqual(v.binding.tabs.map((t) => t.id), [10]);

// rights: opening tabs needs the right; changing it notifies the agent on its next call
fails(await cmd(wa, "open_tab", { url: "https://example.com/new" }), /may not open/);
await popup({ type: "setRights", rights: { newTabs: true } });
r = await cmd(wa, "open_tab", { url: "https://example.com/new" });
const own = ok(r);
assert.match(noticeText(r), /Your rights changed.*open new tabs: yes/);
assert.equal(own.own, true);
assert.deepEqual(ok(await cmd(wa, "list_tabs")).map((t) => t.id).sort(), [10, own.id].sort());
fails(await cmd(wa, "close_tab", { tabId: 10 }), /only tabs you opened/);
ok(await cmd(wa, "close_tab", { tabId: own.id }));
now += 5000;
assert.equal(noticeText(await cmd(wa, "list_tabs")), "", "the agent's own close is not reported back to it");

// cross-domain: refused by default, allowed with the right, and the lock follows the tab
fails(await cmd(wa, "navigate", { tabId: 10, url: "https://other.org/x" }), /another site is not allowed/);
ok(await cmd(wa, "navigate", { tabId: 10, url: "https://www.example.com/sub" })); // same site, other subdomain
await popup({ type: "setRights", rights: { newTabs: true, crossDomain: true } });
ok(await cmd(wa, "navigate", { tabId: 10, url: "https://other.org/x" }));
await popup({ type: "setRights", rights: { newTabs: true, crossDomain: false } }); // locks to other.org now
fails(await cmd(wa, "navigate", { tabId: 10, url: "https://example.com/" }), /another site is not allowed/);
ok(await cmd(wa, "navigate", { tabId: 10, url: "https://other.org/y" }));
now += 5000;
await cmd(wa, "list_tabs"); // drain

// user-made changes reach the agent only on its next call
load(10, "https://other.org/y#frag");
assert.equal(noticeText(await cmd(wa, "list_tabs")), "", "fragment-only change is ignored");
load(10, "https://other.org/z");
r = await cmd(wa, "list_tabs");
assert.match(noticeText(r), /Tab 10 was navigated by the user: https:\/\/other.org\/y#frag -> https:\/\/other.org\/z/);
assert.equal(noticeText(await cmd(wa, "list_tabs")), "", "notices are delivered once");

// switching tabs: told about it without details of tabs it cannot see
T.onActivated.fire({ tabId: 11, previousTabId: 10, windowId: 1 });
r = await cmd(wa, "list_tabs");
assert.match(noticeText(r), /switched away from tab 10 to another tab that you cannot see/);
assert.doesNotMatch(noticeText(r), /11/);
T.onActivated.fire({ tabId: 10, previousTabId: 11, windowId: 1 });
assert.match(noticeText(await cmd(wa, "list_tabs")), /switched to tab 10/);

// a new tab opened by the user, and one opened by a link of the allowed tab
const userTab = mk(30, 1, "about:blank"); tabs.push(userTab); T.onCreated.fire({ ...userTab });
assert.match(noticeText(await cmd(wa, "list_tabs")), /new tab 30.*not accessible/);
const popTab = { ...mk(31, 1, "about:blank"), openerTabId: 10 }; tabs.push(popTab); T.onCreated.fire({ ...popTab });
assert.match(noticeText(await cmd(wa, "list_tabs")), /Tab 10 opened a new tab 31/);

// DevTools on a visible tab
const port = { name: "devtools", sender: { id: "x" }, onMessage: listeners(), onDisconnect: listeners() };
onConnect.fire(port);
port.onMessage.fire({ tabId: 10 });
assert.match(noticeText(await cmd(wa, "list_tabs")), /opened DevTools on tab 10/);
port.onDisconnect.fire();
assert.match(noticeText(await cmd(wa, "list_tabs")), /closed DevTools on tab 10/);
const port2 = { name: "devtools", sender: { id: "x" }, onMessage: listeners(), onDisconnect: listeners() };
onConnect.fire(port2); port2.onMessage.fire({ tabId: 11 });
assert.equal(noticeText(await cmd(wa, "list_tabs")), "", "DevTools on a tab the agent cannot see are not reported");

// the user leaves the allowed site: access to the tab is revoked, with a notice
load(10, "https://example.com/elsewhere");
r = await cmd(wa, "list_tabs");
assert.deepEqual(ok(r), []);
assert.match(noticeText(r), /access to tab 10.*revoked/);
await settle();
assert.equal(pa.get(10).icon, "icons/pa-off.svg");

// tab closed by the user
pageAction.onClicked.fire({ ...tabs.find((t) => t.id === 10) });
await cmd(wa, "list_tabs");
T.onRemoved.fire(10, { windowId: 1 });
tabs = tabs.filter((t) => t.id !== 10);
assert.match(noticeText(await cmd(wa, "list_tabs")), /Tab 10.*was closed by the user/);
tabs.push(mk(10, 1, "https://example.com/a", true));

// full access turns the allow-list mechanism off: everything in the window, nothing elsewhere; button hidden
await popup({ type: "setRights", rights: { newTabs: true, crossDomain: false, full: true } });
await settle();
r = await cmd(wa, "list_tabs");
assert.deepEqual(ok(r).map((t) => t.id).sort(), [10, 11, 30, 31]);
assert.match(noticeText(r), /FULL ACCESS/);
assert.equal(pa.get(10).shown, false);
fails(await cmd(wa, "snapshot", { tabId: 20 }), /not in a window/);
ok(await cmd(wa, "close_tab", { tabId: 31 }));

// second agent in window 2 is independent; A cannot see B's window
v = await popup({ type: "bind", connId: B, windowId: 2 });
assert.equal((await popup({ type: "view", windowId: 2 })).binding.agent.connId, B);
assert.deepEqual(ok(await cmd(wb, "list_tabs")), []);
fails(await cmd(wa, "snapshot", { tabId: 20 }), /not in a window/);
fails(await cmd(wb, "snapshot", { tabId: 10 }), /not in a window/);
await settle();
assert.equal(pa.get(20).shown, true, "button appears for B's restricted window");

// window 1 switches from A to B: A is told; the allow-list follows the agent, not the window
await popup({ type: "setRights", rights: { newTabs: true, crossDomain: false, full: false } });
await popup({ type: "bind", connId: B });
r = await cmd(wa, "list_tabs");
fails(r, /took window 1 away from you.*no longer connected/);
assert.equal(noticeText(r), "", "the reason comes once, in the error");
assert.ok((await popup({ type: "view" })).candidates.every((c) => c.connId !== A), "an evicted agent is not listed as a requester");
assert.deepEqual(ok(await cmd(wb, "list_tabs")), [], "B starts with an empty list");
fails(await cmd(wa, "snapshot", { tabId: 10 }), /took window 1 away/);
assert.match(ok(await cmd(wa, "status")).kicked, /took window 1 away/);
ok(await cmd(wa, "request_access", { name: "Alpha", cwd: "/home/u/projects/alpha", pid: 12 }));
assert.equal(ok(await cmd(wa, "status")).kicked, null);
await popup({ type: "bind", connId: A }); // A returns to window 1: its saved list and rights are back
await cmd(wa, "list_tabs");
assert.equal((await popup({ type: "view" })).binding.rights.newTabs, true);

// an agent that disconnects loses its window; the mechanism and the button go away; the list is kept a week
pageAction.onClicked.fire({ ...tabs.find((t) => t.id === 10) });
await settle();
assert.equal(pa.get(10).icon, "icons/pa-on.svg");
wa.close();
await settle();
assert.equal((await popup({ type: "view" })).binding, null);
assert.equal(pa.get(10).shown, false);
assert.ok((await popup({ type: "view" })).candidates.every((c) => c.connId !== A));

// A reconnects as a new process, claims its old record, user picks it: tabs and rights are back
intervals.filter((i) => i.ms === 4000).forEach((i) => i.fn()); // the periodic port scan reopens the freed port
const wa2 = connect(8767, "c".repeat(32));
ok(await cmd(wa2, "request_access", { name: "Alpha again", resume: ["f".repeat(32), resumeId], cwd: "/home/u/projects/alpha", pid: 13 }));
v = await popup({ type: "view" });
assert.equal(v.candidates.find((c) => c.name === "Alpha again").resume.tabs, 1);
await popup({ type: "bind", connId: "c".repeat(32) });
assert.deepEqual(ok(await cmd(wa2, "list_tabs")).map((t) => t.id), [10]);

// timer: access pauses at expiry (real clock), the window stays linked, the button stays; user can allow again
now += 16 * 60000;
fails(await cmd(wa2, "list_tabs"), /paused/);
tick();
v = await popup({ type: "view" });
assert.equal(v.binding.active, false);
assert.equal(v.binding.agent.name, "Alpha again");
assert.match(noticeText(await cmd(wa2, "status")), /ran out/);
await popup({ type: "grant", minutes: 5 });
assert.equal((await popup({ type: "view" })).binding.expiresAt - now, 5 * 60000);
ok(await cmd(wa2, "list_tabs"));
// extend raises to the default only when lower; revoke pauses at once
now += 2 * 60000;
assert.equal((await popup({ type: "extend" })).binding.expiresAt - now, 15 * 60000);
const same = (await popup({ type: "extend" })).binding.expiresAt;
assert.equal(same - now, 15 * 60000);
await popup({ type: "revoke" });
fails(await cmd(wa2, "list_tabs"), /paused/);
assert.match((await popup({ type: "setDefault", minutes: 0 })).error, /minutes/);

// unbind removes the agent from the browser: not listed any more, the next call says why, it may ask again
await popup({ type: "unbind" });
v = await popup({ type: "view" });
assert.equal(v.binding, null);
assert.ok(v.candidates.every((c) => c.connId !== "c".repeat(32)));
fails(await cmd(wa2, "list_tabs"), /ended your access to window 1 and removed you/);
assert.match(ok(await cmd(wa2, "status")).kicked, /removed you/);
ok(await cmd(wa2, "request_access", { name: "Alpha again", cwd: "/home/u/projects/alpha", pid: 13 }));
assert.ok((await popup({ type: "view" })).candidates.some((c) => c.name === "Alpha again"));

// the saved list is dropped a week after the agent left
wa2.close();
now += 8 * 24 * 3600 * 1000;
intervals.filter((i) => i.ms === 3600 * 1000).forEach((i) => i.fn());
intervals.filter((i) => i.ms === 4000).forEach((i) => i.fn());
const wa3 = connect(8767, "d".repeat(32));
ok(await cmd(wa3, "request_access", { name: "Late", resume: [resumeId], cwd: "/x", pid: 14 }));
assert.equal((await popup({ type: "view" })).candidates.find((c) => c.name === "Late").resume, null);

// renaming the profile is announced to every connected server and survives in storage
const open = [...sockets.values()].filter((w) => w.readyState === 1);
assert.equal((await popup({ type: "setProfile", label: "Work\n" })).profileLabel, "Work");
assert.equal(store.profile.label, "Work");
assert.ok(open.every((w) => w.sent.at(-1).type === "profile" && w.sent.at(-1).label === "Work"));
assert.match((await popup({ type: "setProfile", label: "  " })).error, /пуст/);

console.log("agent tests passed");
