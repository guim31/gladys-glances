# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Up to three Glances servers (NAS, home server, PC), read over the local
  network through the REST API of the Glances web server (`glances -w`),
  version 4 or 3, with or without a password.
- One device per server, proposed in the Discover tab: online, CPU, memory,
  swap, load averages (1, 5 and 15 minutes), uptime, running containers and
  highest temperature. Feature names are in French by default (English,
  German and Spanish available).
- One device per disk (space used and free), network interface (download and
  upload rates), temperature sensor and Docker or Podman container (running,
  CPU, memory), proposed in the Discover tab for the user to pick. A container
  keeps its device when it is recreated under the same name.
- Scene triggers for every disk, sensor and container, added to Gladys or
  not: disk almost full (80 to 98 %), high temperature (50 to 100 °C,
  confirmed over two reads), container stopped (confirmed over two reads, an
  update is no stop) and server unreachable. What was announced survives a
  restart.
- A "State of a server" scene action: every figure as an output, and a
  ready-made summary for a message.
- A "Glances server" dashboard widget: CPU, memory and disk gauges, the
  highest temperature, the running containers, the stopped ones, the load and
  the uptime, and a Refresh button.
- A "Test the connection" button, a connection status naming the server and
  the problem, and a transport badge per device.
- Interface texts and documentation in English, French, German and Spanish.
- Apache-2.0 `LICENSE` file.

[Unreleased]: https://github.com/guim31/gladys-glances/commits/main
