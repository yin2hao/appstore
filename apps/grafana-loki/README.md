## 产品介绍

**Grafana Loki** 用于集中存储和查询日志。Loki 按标签索引日志流，可以用 LogQL 查询日志。

本应用以单实例运行，使用本地文件系统存储日志。可通过 Grafana Alloy 向 `/loki/api/v1/push` 写入日志，再在 Grafana 中添加 Loki 数据源查询日志。

Loki 的 HTTP 接口没有内置身份验证。请将端口限制在受信任的网络内。
