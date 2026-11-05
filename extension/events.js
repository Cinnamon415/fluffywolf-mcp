// Browser events -> notices for agents, and the address-bar button that allows a tab for the agent of its window.
//
// What an agent hears about: the tabs it can see (allowed or touched), a new tab in its window, the user
// switching tabs, DevTools, and any change of its own rights. Scrolling and clicking are not reported, and neither
// are URL changes that only differ by #fragment. Nothing about tabs it cannot see is revealed beyond "another tab".
/* global browser, bindings, agents, allow, recordOf, agentForWindow, activeWindows, entryOf, allowTab, disallowTab,
   revokeTab, hydrateTab, refreshChrome, notify, sameSite, siteOf, stripHash, persistTab, countAllowed */

const tabMeta = new Map(); // tabId -> { url, title, windowId }
const devtoolsTabs = new Set();

const quote = (s) => (s ? ` ("${String(s).slice(0, 80)}")` : "");

async function initMeta() {
  try {
    for (const t of await browser.tabs.query({})) tabMeta.set(t.id, { url: t.url, title: t.title, windowId: t.windowId });
  } catch {}
}
initMeta();

// Agents with live access to this window, with whether each one can see `tabId`.
function watchers(windowId, tabId) {
  const out = [];
  const a = agentForWindow(windowId, true);
  if (!a) return out;
  const rec = recordOf(a);
  const entry = tabId == null ? null : entryOf(rec.id, tabId);
  out.push({ agent: a, rec, entry, sees: rec.rights.full ? a.touched.has(tabId) : !!entry });
  return out;
}

const quiet = (agent) => agent.busyUntil > Date.now();

// ---------- tabs ----------

browser.tabs.onCreated.addListener((tab) => {
  tabMeta.set(tab.id, { url: tab.url, title: tab.title, windowId: tab.windowId });
  hydrateTab(tab.id).then(() => updatePageAction(tab));
  const agent = agentForWindow(tab.windowId, true);
  if (!agent || quiet(agent)) return;
  const rec = recordOf(agent);
  const opener = tab.openerTabId != null && (agent.touched.has(tab.openerTabId) || entryOf(rec.id, tab.openerTabId));
  const access = rec.rights.full ? "It is accessible to you (full access)." : "It is not accessible to you unless the user allows it.";
  notify(agent, "created", opener
    ? `Tab ${tab.openerTabId} opened a new tab ${tab.id} (link or script). ${access}`
    : `The user opened a new tab ${tab.id} in the shared window. ${access}`);
});

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  const prev = tabMeta.get(tabId);
  tabMeta.set(tabId, { url: tab.url, title: tab.title, windowId: tab.windowId });
  if (change.url !== undefined) onUrlChange(tab, prev ? prev.url : "", change.url);
  if (change.url !== undefined || change.status !== undefined) updatePageAction(tab);
});

function onUrlChange(tab, oldUrl, newUrl) {
  for (const { agent, rec, entry, sees } of watchers(tab.windowId, tab.id)) {
    if (!sees) continue;
    if (entry && entry.pending) { entry.site = siteOf(newUrl) || entry.site; entry.url = newUrl; continue; }
    if (entry && !rec.rights.full) {
      if (!rec.rights.crossDomain && !sameSite(entry.site, newUrl)) {
        revokeTab(rec, tab.id, `navigated to another site than ${entry.site}, and cross-domain navigation is not granted`);
        continue;
      }
      if (rec.rights.crossDomain) entry.site = siteOf(newUrl) || entry.site;
      entry.url = newUrl;
      persistTab(tab.id);
    }
    if (stripHash(oldUrl) === stripHash(newUrl) || quiet(agent)) continue;
    notify(agent, `url:${tab.id}`, `Tab ${tab.id} was navigated by the user: ${oldUrl} -> ${newUrl}`);
  }
}

browser.tabs.onRemoved.addListener((tabId, info) => {
  const meta = tabMeta.get(tabId);
  for (const { agent, sees } of watchers(info.windowId, tabId)) {
    if (!sees) continue;
    agent.touched.delete(tabId);
    if (agent.current === tabId) agent.current = null;
    if (agent.closing === tabId) { agent.closing = null; continue; }
    if (info.isWindowClosing) continue; // the window-closed notice covers it
    notify(agent, `closed:${tabId}`, `Tab ${tabId}${quote(meta && meta.title)} was closed by the user.`);
  }
  allow.delete(tabId);
  tabMeta.delete(tabId);
  devtoolsTabs.delete(tabId);
});

browser.tabs.onActivated.addListener(({ tabId, previousTabId, windowId }) => {
  const agent = agentForWindow(windowId, true);
  if (agent && !quiet(agent)) {
    const rec = recordOf(agent);
    const sees = (id) => id != null && (rec.rights.full ? agent.touched.has(id) : !!entryOf(rec.id, id));
    if (sees(tabId)) notify(agent, "active", `The user switched to tab ${tabId}${quote(tabMeta.get(tabId)?.title)}.`);
    else if (sees(previousTabId)) notify(agent, "active", `The user switched away from tab ${previousTabId} to another tab${rec.rights.full ? ` (${tabId})` : " that you cannot see"}.`);
  }
  browser.tabs.get(tabId).then(updatePageAction).catch(() => {});
});

browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  for (const { agent, sees } of watchers(oldWindowId, tabId)) {
    if (sees) notify(agent, `moved:${tabId}`, `Tab ${tabId} was moved by the user to another window; it is no longer accessible to you.`);
  }
});

browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  const meta = tabMeta.get(tabId);
  if (meta) meta.windowId = newWindowId;
  browser.tabs.get(tabId).then(updatePageAction).catch(() => {});
});

browser.windows.onCreated.addListener(() => refreshChrome());
browser.windows.onRemoved.addListener((windowId) => {
  const b = bindings.get(windowId);
  if (!b) return;
  bindings.delete(windowId);
  const agent = agents.get(b.connId);
  if (agent) notify(agent, `win:${windowId}`, `Window ${windowId} was closed by the user; your access to it ended.`);
  refreshChrome();
});

// ---------- DevTools (a devtools_page reports every toolbox through a port that lives as long as the toolbox) ----------

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "devtools" || port.sender.id !== browser.runtime.id) return;
  let tabId = null;
  port.onMessage.addListener((m) => {
    if (!m || !Number.isInteger(m.tabId) || tabId !== null) return;
    tabId = m.tabId;
    devtoolsTabs.add(tabId);
    tellDevtools(tabId, "opened");
  });
  port.onDisconnect.addListener(() => {
    if (tabId === null) return;
    devtoolsTabs.delete(tabId);
    tellDevtools(tabId, "closed");
  });
});

function tellDevtools(tabId, what) {
  const windowId = tabMeta.get(tabId)?.windowId;
  for (const { agent, sees } of watchers(windowId, tabId)) {
    if (sees) notify(agent, `devtools:${tabId}`, `The user ${what} DevTools on tab ${tabId}.`);
  }
}

// ---------- address-bar button ----------

// The button exists only in windows whose agent is restricted; with full access or no agent there is nothing to set.
function restrictedAgent(windowId) {
  const agent = agentForWindow(windowId);
  const rec = agent && recordOf(agent);
  return rec && !rec.rights.full ? { agent, rec } : null;
}

async function updatePageAction(tab) {
  if (!tab || tab.id == null) return;
  const found = restrictedAgent(tab.windowId);
  try {
    if (!found) { await browser.pageAction.hide(tab.id); return; }
    const on = !!entryOf(found.rec.id, tab.id);
    await browser.pageAction.setIcon({ tabId: tab.id, path: on ? "icons/pa-on.svg" : "icons/pa-off.svg" });
    await browser.pageAction.setTitle({
      tabId: tab.id,
      title: on ? `Агент «${found.agent.name}» может работать с этой вкладкой. Нажмите, чтобы закрыть доступ`
        : `Разрешить агенту «${found.agent.name}» работать с этой вкладкой`,
    });
    await browser.pageAction.show(tab.id);
  } catch {}
}

async function refreshPageActions() {
  try {
    for (const t of await browser.tabs.query({})) updatePageAction(t);
  } catch {}
}

browser.pageAction.onClicked.addListener((tab) => {
  const found = restrictedAgent(tab.windowId);
  if (!found) return;
  const { agent, rec } = found;
  const meta = tabMeta.get(tab.id);
  if (entryOf(rec.id, tab.id)) {
    disallowTab(rec.id, tab.id);
    notify(agent, `allow:${tab.id}`, `The user removed your access to tab ${tab.id}${quote(meta && meta.title)}.`);
  } else {
    allowTab(rec.id, tab);
    notify(agent, `allow:${tab.id}`, `The user allowed you to use tab ${tab.id}${quote(meta && meta.title)}: ${tab.url}`);
  }
  updatePageAction(tab);
});
