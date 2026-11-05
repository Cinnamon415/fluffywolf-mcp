# Changelog

## 1.3.2

- The popup has a "Decline" button next to every pending agent. The agent disappears from the list and its next call says that the user declined; it may ask again.

## 1.3.1

- Fix: a server that started after the browser could stay unconnected for up to a minute, and agents then reported "no browser profile is connected". Firefox delays WebSocket reconnects after failed attempts, and the extension tried every port every four seconds. It now probes each port with a plain HTTP request first and opens a WebSocket only where a server answers.
- A server that has just started waits up to eight seconds for the browser before it reports that no profile is connected, and the message says to retry shortly.

## 1.3.0

First public version.

- Per-window access: agents introduce themselves with `request_access`; you pick one in the popup and it gets that window only.
- Rights per agent: open new tabs, go to other sites, full access. A timer pauses access automatically.
- Per-tab allow-list with an address-bar button. Records are kept for a week after an agent disconnects, and an agent can resume with its id.
- Notices to the agent on its next call when you switch, open or close tabs, open DevTools or navigate, and when its rights or window change.
- Several agents at once, each with its own MCP server process and port (8767–8776).
- Several browser profiles at once, fully isolated. Agents list the profiles, then ask the ones they need.
- Removing an agent drops it from the popup at once; its next call explains what happened.
- Releases ship an `.xpi` built with a public default token that the server also uses when it finds no other. Building it yourself generates a random token of your own.
- Popup control panel with light and dark themes. The popup text is Russian.
