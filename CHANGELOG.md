# Changelog

## 1.3.0

First public version.

- Per-window access: agents introduce themselves with `request_access`; you pick one in the popup and it gets that window only.
- Rights per agent: open new tabs, go to other sites, full access. A timer pauses access automatically.
- Per-tab allow-list with an address-bar button. Records are kept for a week after an agent disconnects, and an agent can resume with its id.
- Notices to the agent on its next call when you switch, open or close tabs, open DevTools or navigate, and when its rights or window change.
- Several agents at once, each with its own MCP server process and port (8767–8776).
- Several browser profiles at once, fully isolated. Agents list the profiles, then ask the ones they need.
- Removing an agent drops it from the popup at once; its next call explains what happened.
- Popup control panel with light and dark themes. The popup text is Russian.
