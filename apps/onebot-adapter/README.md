## 产品介绍

**OneBot Adapter** 接收 Alertmanager 的告警和恢复通知，并通过 OneBot 11 发送到群聊或私聊。你可以在管理页面配置接收端并试发消息。

安装后，在应用安装目录的 `config/config.json` 中查看管理员密码和 Webhook 令牌。用 `admin` 和 `admin_password` 登录管理页面。将 `webhook_token` 配置为 Alertmanager 的 Bearer 令牌。

远程访问管理页面时，使用 HTTPS 反向代理，并保留原始 `Host` 请求头。

如果 Alertmanager 和 OneBot 也连接到 `1panel-network`，在服务地址中使用容器名和容器端口。Alertmanager 的目标路径为 `/webhook/<接收端名称>`。
