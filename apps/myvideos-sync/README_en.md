## Introduction

**MyVideos Sync** is a self-hosted WebDAV disaster-recovery sync service for My Videos. It exposes HTTP APIs to trigger sync jobs that mirror new, changed, and deleted files from primary WebDAV to disaster WebDAV.

## Features

- **Full and Selected Sync**: Supports full mirror sync and selected sync by difference file paths.
- **Concurrency and Traffic Budget**: Provides concurrency controls and traffic budget limits to balance sync speed and bandwidth usage.
- **Status and Job APIs**: Provides health, difference, and job status endpoints for client-side progress views.
