## Introduction

**Grafana Loki** stores logs in one place. Loki indexes log streams by label. Use LogQL to query logs.

This package runs a single Loki instance and stores logs on the local file system. Send logs to `/loki/api/v1/push` with Grafana Alloy. Add a Loki data source in Grafana to query the logs.

The Loki HTTP interface has no built-in authentication. Limit access to a trusted network.
