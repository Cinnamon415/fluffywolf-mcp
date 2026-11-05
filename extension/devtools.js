// Loaded by the browser whenever the user opens DevTools on a tab. The open port tells the background page that a
// toolbox exists for this tab; closing the toolbox disconnects it.
/* global browser */
const port = browser.runtime.connect({ name: "devtools" });
port.postMessage({ tabId: browser.devtools.inspectedWindow.tabId });
