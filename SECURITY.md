# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the repository's **Security** tab → **Report a vulnerability**) instead of a public issue. Include the browser and version, the steps to reproduce and what an agent or a web page could do as a result.

## What this project protects, and what it does not

FluffyWolf MCP limits what an AI agent can do **through the browser**: which windows, which tabs, which sites and for how long. The rules are enforced by the browser extension. See the [Security model](README.md#security-model) in the README for the details and the known limitations.

A few points worth repeating:

- The bridge listens on `127.0.0.1` only and accepts only extension origins that present the shared secret.
- Releases are built with a **public default token** (`default.token`), which the server also falls back to. It is meant for a quick try: anything on your machine can read it. For real use, build the extension yourself so the token inside it is yours. See [About the token](README.md#about-the-token). The server prints a warning while it uses the default.
- A process that already runs as your user can read your browser profile and `.token`. This tool does not defend against that.

## Supported versions

Only the latest release receives fixes.
