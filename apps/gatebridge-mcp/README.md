## 产品介绍

GateBridge MCP 将现有 ESP32/MG946R 闸门控制服务接入 MCP（Model Context Protocol，模型上下文协议）。

服务以控制器身份连接原后端，无需修改原服务端和 ESP32 固件。项目说明见 [官方仓库](https://github.com/yin2hao-tools/GateBridge-MCP)。

## 主要功能

- 闸门操作：提供 `gate_open`、`gate_close` 和 `gate_get_status` 三个工具，支持开门、关门和读取最近状态。
- 接口说明：提供设备、状态和协议三个资源，以及操作提示模板。机器人通过 `/mcp` 接入 Streamable HTTP，使用独立的 Bearer 令牌认证。
- 断线恢复：上游 WebSocket 断开后自动重连并重新认证，开关命令不会自动重放。
- 结果语义：`queued` 仅表示原后端已转发命令，不能证明闸门已到位。
