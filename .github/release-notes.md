> [!WARNING]
> **This `.xpi` is built with a public default token.** The token is published in [`default.token`](https://github.com/Cinnamon415/fluffywolf-mcp/blob/main/default.token), and the MCP server uses the same value when it finds no other. Anything on your computer can read it, so anything on your computer could pose as your browser to the MCP server and watch what your agent does. It cannot widen the agent's rights, which stay in the extension. This build is for a quick try on a machine only you use.
>
> **To use your own token**, build the extension yourself (`npm run setup`) and install your build instead. The server picks your token up from `.token` by itself. Details: [About the token](https://github.com/Cinnamon415/fluffywolf-mcp#about-the-token).

## Install

1. Clone the repository and run `npm --prefix server install`.
2. Install `fluffywolf-mcp.xpi` in each browser profile you want agents to use. Unsigned add-ons need a browser that honours `xpinstall.signatures.required=false` (LibreWolf, Firefox ESR, Developer Edition, Nightly), or a temporary install from `about:debugging`.
3. Register `server/index.mjs` in your MCP client.

Full instructions: [README](https://github.com/Cinnamon415/fluffywolf-mcp#quick-start). Changes: [CHANGELOG](https://github.com/Cinnamon415/fluffywolf-mcp/blob/main/CHANGELOG.md).

The `.xpi` is built by GitHub Actions from the tagged commit. Its SHA-256 is in `fluffywolf-mcp.xpi.sha256`.
