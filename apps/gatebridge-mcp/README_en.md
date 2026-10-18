## Introduction

**GateBridge MCP** connects an existing ESP32/MG946R gate controller to MCP (Model Context Protocol). It connects to the upstream server as a controller without changing the original server or ESP32 firmware. See the [official repository](https://github.com/yin2hao-tools/GateBridge-MCP).

## Features

- **Gate tools**: Provides gate_open, gate_close and gate_get_status for opening, closing and reading the latest reported state.
- **MCP interfaces**: Provides device, status and protocol resources plus an operation prompt. Clients connect to /mcp over Streamable HTTP using a separate Bearer token.
- **Connection recovery**: Reconnects and authenticates after an upstream WebSocket disconnect without replaying gate commands.
- **Command results**: queued confirms upstream forwarding only; it does not confirm the physical gate position.
