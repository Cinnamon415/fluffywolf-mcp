// Background page: the commands an agent may run. Every command receives the calling agent and goes through
// the checks in gate.js (shared windows, allowed tabs, rights). Connection handling lives in gate.js.
/* global browser, siteOf, sameSite, activeWindows, recordOf, authorizeTab, visibleTabs, allowTab, entryOf, tabMeta */

const NAV_TIMEOUT_MS = 30000;

// ---------- helpers ----------

function describeTab(t, extra = {}) {
  return { id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status, pinned: t.pinned, ...extra };
}

function waitForLoad(tabId, timeout = NAV_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const done = (note) => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(note);
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done("loaded"); };
    const timer = setTimeout(() => done("timeout"), timeout);
    browser.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContent(tabId) {
  try {
    const r = await browser.tabs.sendMessage(tabId, { op: "ping" });
    if (r === "pong") return;
  } catch {}
  try {
    await browser.tabs.executeScript(tabId, { file: "content.js" });
  } catch (e) {
    throw new Error(`cannot script this tab (restricted page or still loading): ${e.message}`);
  }
}

// Without a tabId the agent gets the tab it used last, else the active tab of a shared window, else any visible one.
async function resolveTab(agent, tabId) {
  if (typeof tabId === "number") {
    try { return await browser.tabs.get(tabId); } catch { throw new Error(`Tab ${tabId} does not exist.`); }
  }
  const vis = await visibleTabs(agent);
  const pick = vis.find((v) => v.tab.id === agent.current) || vis.find((v) => v.tab.active) || vis[0];
  if (!pick) throw new Error("No tab is available to you yet. The user has to allow a tab with the FluffyWolf MCP button in the address bar" + (recordOf(agent).rights.newTabs ? ", or you can open one with open_tab." : "."));
  return pick.tab;
}

async function target(agent, tabId) {
  const tab = await resolveTab(agent, tabId);
  const entry = authorizeTab(agent, tab);
  agent.current = tab.id;
  return { tab, entry };
}

function mayLeaveSite(agent) {
  const r = recordOf(agent).rights;
  return r.full || r.crossDomain;
}

async function callContent(agent, tabId, message) {
  const { tab } = await target(agent, tabId);
  await ensureContent(tab.id);
  const res = await browser.tabs.sendMessage(tab.id, message);
  if (res && res.error) throw new Error(res.error);
  return res;
}

// After back/forward/reload a page can end up on another site; with no cross-domain right the tab is dropped.
async function afterNavigation(agent, tab, entry) {
  const fresh = await browser.tabs.get(tab.id);
  if (entry && !mayLeaveSite(agent) && !sameSite(entry.site, fresh.url)) {
    authorizeTab(agent, fresh); // revokes the tab, tells the agent and throws
  }
  return fresh;
}

// ---------- commands ----------

const commands = {
  async list_tabs(_args, agent) {
    return (await visibleTabs(agent)).map(({ tab, entry }) => describeTab(tab, { own: !!(entry && entry.own) }));
  },

  async open_tab({ url, active = true, windowId }, agent) {
    const rec = recordOf(agent);
    if (!rec.rights.full && !rec.rights.newTabs) throw new Error("You may not open new tabs: the user has not granted that right.");
    const wins = activeWindows(agent);
    const current = agent.current != null ? tabMeta.get(agent.current)?.windowId : null;
    const win = Number.isInteger(windowId) ? windowId : wins.includes(current) ? current : wins[0];
    if (!wins.includes(win)) throw new Error(`Window ${win} is not shared with you.`);
    const tab = await browser.tabs.create({ url: url || "about:blank", active, windowId: win });
    agent.touched.add(tab.id);
    agent.current = tab.id;
    // Own tabs are allowed automatically; the site is fixed once the first load is done.
    let entry = null;
    if (!rec.rights.full) { entry = allowTab(rec.id, tab, true); entry.pending = true; }
    if (url) await waitForLoad(tab.id);
    const fresh = await browser.tabs.get(tab.id);
    if (entry) { entry.pending = false; entry.site = siteOf(fresh.url) || entry.site; entry.url = fresh.url; }
    return describeTab(fresh, { own: true });
  },

  async close_tab({ tabId }, agent) {
    const { tab, entry } = await target(agent, tabId);
    if (!recordOf(agent).rights.full && !(entry && entry.own)) {
      throw new Error("You may close only tabs you opened yourself.");
    }
    agent.closing = tab.id;
    await browser.tabs.remove(tab.id);
    return { closed: tab.id };
  },

  async activate_tab({ tabId }, agent) {
    const { tab } = await target(agent, tabId);
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return describeTab(await browser.tabs.get(tab.id));
  },

  async navigate({ tabId, url }, agent) {
    const { tab, entry } = await target(agent, tabId);
    let next;
    try { next = new URL(url, tab.url).href; } catch { throw new Error(`Invalid URL: ${url}`); }
    if (entry && !mayLeaveSite(agent) && !sameSite(entry.site, next)) {
      throw new Error(`Navigating to another site is not allowed: this tab is limited to ${entry.site} and the user has not granted cross-domain navigation.`);
    }
    await browser.tabs.update(tab.id, { url: next });
    const state = await waitForLoad(tab.id);
    return { ...describeTab(await afterNavigation(agent, tab, entry)), wait: state };
  },

  async history({ tabId, action }, agent) {
    const { tab, entry } = await target(agent, tabId);
    if (action === "back") await browser.tabs.goBack(tab.id);
    else if (action === "forward") await browser.tabs.goForward(tab.id);
    else if (action === "reload") await browser.tabs.reload(tab.id);
    else throw new Error("action must be back, forward or reload");
    const state = await waitForLoad(tab.id);
    return { ...describeTab(await afterNavigation(agent, tab, entry)), wait: state };
  },

  async screenshot({ tabId }, agent) {
    const { tab } = await target(agent, tabId);
    const dataUrl = await browser.tabs.captureTab(tab.id, { format: "png" });
    return { dataUrl };
  },

  snapshot: (a, agent) => callContent(agent, a.tabId, { op: "snapshot", maxChars: a.maxChars }),
  get_text: (a, agent) => callContent(agent, a.tabId, { op: "get_text", selector: a.selector, maxChars: a.maxChars }),
  click: (a, agent) => callContent(agent, a.tabId, { op: "click", ref: a.ref, selector: a.selector, x: a.x, y: a.y, double: a.double }),
  type_text: (a, agent) => callContent(agent, a.tabId, { op: "type", ref: a.ref, selector: a.selector, text: a.text, clear: a.clear, submit: a.submit }),
  press_key: (a, agent) => callContent(agent, a.tabId, { op: "key", key: a.key, ref: a.ref }),
  scroll: (a, agent) => callContent(agent, a.tabId, { op: "scroll", ref: a.ref, dx: a.dx, dy: a.dy, to: a.to }),
  evaluate: (a, agent) => callContent(agent, a.tabId, { op: "evaluate", code: a.code, world: a.world }),
};
