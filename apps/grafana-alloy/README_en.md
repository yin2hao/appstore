## Introduction

**Grafana Alloy** is a distribution of the OpenTelemetry Collector. It includes Prometheus components that can collect, process, and forward metrics, logs, traces, and profiles.

The default configuration sets only Alloy's own logging. Edit `config/config.alloy` to set the data sources and destinations. Then restart the app.

## Telemetry ports

From package version `v1.21.3-2`, 1Panel lets you set the host ports for Faro (`12347`), OTLP gRPC (`4317`), and OTLP HTTP (`4318`).

To receive telemetry, enable the receiver in `config/config.alloy` and make it listen on the container network interface. For Faro's `/collect` endpoint, set `faro.receiver` to listen on `0.0.0.0:12347`.
