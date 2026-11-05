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

---

## 🇷🇺 По-русски

> [!WARNING]
> **Этот `.xpi` собран с публичным токеном по умолчанию.** Токен опубликован в [`default.token`](https://github.com/Cinnamon415/fluffywolf-mcp/blob/main/default.token), и MCP-сервер использует то же значение, если не нашёл другого. Любая программа на вашем компьютере может его прочитать и выдать себя серверу за ваш браузер, а затем видеть, что делает ваш агент. Расширить права агента она не может: они остаются в расширении. Эта сборка подходит для быстрого знакомства на компьютере, которым пользуетесь только вы.
>
> **Чтобы получить свой токен,** соберите расширение сами (`npm run setup`) и поставьте свою сборку. Скрипт сборки сам создаёт случайный токен, а сервер подхватывает его из `.token`. Подробности: [О токене](https://github.com/Cinnamon415/fluffywolf-mcp/blob/main/README.ru.md#о-токене).

**Установка:** склонируйте репозиторий и выполните `npm --prefix server install`, поставьте `fluffywolf-mcp.xpi` в каждый профиль браузера и подключите `server/index.mjs` в вашем MCP-клиенте. Полная инструкция: [README на русском](https://github.com/Cinnamon415/fluffywolf-mcp/blob/main/README.ru.md#быстрый-старт).
