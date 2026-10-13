# Glances for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
follows your **other machines** — a NAS, a home server, a PC — through
[Glances](https://nicolargo.github.io/glances/), the cross-platform monitoring
tool: CPU, memory, swap, load, uptime, disks, network rates, temperatures and
Docker or Podman containers. It reads the REST API of the Glances web server
(`glances -w`, API v4 and v3) over the local network. No cloud, no account.

It complements the host monitoring of the Gladys machine itself: here, every
machine that runs Glances.

> Tested against real Glances 4.5.8 and 3.4.0.5 servers (Docker), with and
> without a password; containers through a simulated Docker engine. Not yet
> in a real Gladys nor on every NAS: feedback welcome in the
> [issues](https://github.com/guim31/gladys-glances/issues).

## Features

- **Up to three servers**, each with its address, optional user name and
  password, and name.
- **One device per server**, proposed in the Discover tab: **Online**,
  **CPU**, **Memory**, **Swap**, **Load** (1, 5 and 15 min), **Uptime**,
  **Running containers** and **Highest temperature**.
- **One device per disk** (space used, free space), **network interface**
  (download and upload rates), **temperature sensor** and **container**
  (running, CPU, memory), also proposed in the Discover tab: the user adds
  only what matters. A container keeps its device when it is recreated under
  the same name. Feature names in French by default (English, German and
  Spanish available).
- **Scene triggers**, for every disk, sensor and container, added to Gladys
  or not: _Disk almost full_ (80 to 98 %), _High temperature_ (50 to 100 °C,
  two reads in a row), _Container stopped_ (two reads in a row, an update is
  no stop) and _Server unreachable_. Each threshold is a filter of the
  trigger.
- **Scene action** _State of a server_: every figure as an output, and a
  ready-made summary for a message.
- **Dashboard widget** "Glances server": CPU, memory and disk gauges, the
  highest temperature, running and stopped containers, load and uptime, and a
  **Refresh** button.
- A **Test the connection** button, a connection status naming the server and
  the problem, a **transport badge** per device.
- Only the changes are sent to Gladys, the values that move all the time at
  most once a minute, within a budget of 240 states per minute.
- Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later (widgets, scene triggers and actions).
- **Glances 3.x or 4.x** started as a web server (`glances -w`, or the
  `nicolargo/glances` Docker image with `GLANCES_OPT="-w"`) on each machine,
  reachable from the Gladys machine (port 61208 by default).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-glances`
   (or install **Glances** from the catalog once it is listed).
2. In **Configuration**, enter the address of Glances (`192.168.1.20`,
   `nas.lan`, `http://nas.lan:61208`…), its password if it has one, and a
   name; up to two more servers below. Save, then click **Test the
   connection**.
3. Open the **Discover** tab and add the server, then the disks, interfaces,
   sensors and containers to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- Every refresh interval (15 s to 5 min, 30 s by default), the integration
  reads each server: one GET per plugin (`cpu`, `load`, `mem`, `memswap`,
  `uptime`, `fs`, `network`, `sensors`, `containers`), never `/api/<v>/all`
  and its process list. The API version is detected from
  `/api/<v>/pluginslist`; the plugins disabled on the server are skipped.
- The devices are published with `should_poll: false`: the integration drives
  the reads with its own timer. Only the devices the user added receive
  states.
- The scene triggers compare each read with the previous ones (kept in
  `/data/glances-state.json`), so a restart neither repeats an announcement
  nor misses one.

## Checked on a real Glances, and what was not

See the section of the same name in [`CLAUDE.md`](CLAUDE.md) for the details.
In short, the Docker image of the integration ran with the Gladys sandbox
constraints (read-only root, all capabilities dropped, 256 MB, bridge network)
against real `nicolargo/glances` 4.5.8 and 3.4.0.5 containers, with and
without a password, plugins disabled, a disk filled up, and containers
stopped through a simulated Docker engine (no host Docker socket was mounted).
Not checked: a real Gladys (the widget, the scene editor), Glances on a real
NAS (Synology, Unraid, TrueNAS), Podman, Glances behind a reverse proxy.

## Limitations

- Read only: nothing is started or stopped, neither containers nor machines.
- Three servers per installation.
- With its default settings Glances lists the running containers only: a
  stopped container is seen as gone (`all=True` in the `[containers]`
  section of `glances.conf` lists them all).
- GPU, RAID, disk I/O, processes, fans and batteries are not read.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and an in-memory Glances (`test/helpers/fakeGlances.js`) serving real answers
of Glances 4.5.8 and 3.4.0.5 (`test/fixtures/glances/`). See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- [Glances](https://github.com/nicolargo/glances) by Nicolas Hennion and
  contributors (LGPL-3.0): the REST API read here. The logo on the cover is
  the official one, from its repository (`docs/_static/Glances Text Logo.svg`).
- [glances-api](https://github.com/home-assistant-ecosystem/python-glances-api)
  by Fabian Affolter (MIT), the library of Home Assistant's
  [`glances`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/glances)
  integration (Apache-2.0): the choice of sensors and the differences between
  API v3 and v4; its test fixtures are reused in
  `test/fixtures/glances/glances-api.json`.
- The architecture and the conformity tests follow
  [gladys-uptime-kuma](https://github.com/guim31/gladys-uptime-kuma) and
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by the Glances
project or its authors.

## License

Apache-2.0
