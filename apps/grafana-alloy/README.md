## 产品介绍

**Grafana Alloy** 是 OpenTelemetry Collector 的发行版。它内置 Prometheus 采集组件，可采集、处理和转发指标、日志、追踪和性能剖析数据。

默认配置仅设置 Alloy 自身的日志。请编辑 `config/config.alloy`，配置采集来源和发送目标，然后重启应用。

## 遥测端口

从编排版本 `v1.21.3-2` 开始，可在 1Panel 设置 Faro 的 `12347`、OTLP gRPC 的 `4317` 和 OTLP HTTP 的 `4318` 宿主机端口。

接收遥测前，请在 `config/config.alloy` 启用对应的接收器，并让它监听容器的网络接口。若使用 Faro 的 `/collect`，请让 `faro.receiver` 监听 `0.0.0.0:12347`。
