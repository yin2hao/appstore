## Introduction

[Alertmanager](https://github.com/prometheus/alertmanager) receives alerts from clients such as Prometheus. It removes duplicate alerts, groups alerts and routes notifications.

The default receiver sends no notifications. Before use, edit `config/alertmanager.yml` to add a notification receiver, then restart the app. See the [official configuration documentation](https://prometheus.io/docs/alerting/latest/configuration/).

Authentication and TLS are disabled by default. Restrict access or use a reverse proxy with authentication.

## Features

- Group related alerts and remove duplicate alerts to reduce repeated notifications.
- Route notifications to receivers such as email and webhooks.
- View alerts and manage silences in the web interface.
- Store silences and notification state across restarts in a single instance.
