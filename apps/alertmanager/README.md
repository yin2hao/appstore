## 产品介绍

[Alertmanager](https://github.com/prometheus/alertmanager) 接收 Prometheus 等客户端发送的告警，处理告警去重、分组和通知路由。

默认接收器不发送通知。使用前，请按[官方配置文档](https://prometheus.io/docs/alerting/latest/configuration/)编辑 `config/alertmanager.yml`，添加通知接收渠道，然后重启应用。

默认不启用认证和 TLS。请限制访问来源，或通过带认证的反向代理访问。

## 主要功能

- 将重复或相关告警合并，减少重复通知。
- 按路由规则向邮件、Webhook 等接收渠道发送通知。
- 在 Web 界面查看告警并管理静默规则。
- 持久化静默规则和通知状态，单实例运行。
