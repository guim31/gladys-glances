# Glances

[Glances](https://nicolargo.github.io/glances/) is a cross-platform monitoring
tool: CPU, memory, disks, network, temperatures, Docker and Podman containers.
This integration reads the Glances web server of your **other machines** — a
NAS, a home server, a PC — and brings them into Gladys: one device per server,
and the disks, network interfaces, temperature sensors and containers you
choose. Scenes can react when a disk fills up, a machine overheats, a
container stops or a server no longer answers, and a dashboard widget sums a
server up. Everything stays on your local network.

Tested against real Glances 4.5.8 and 3.4.0.5 servers (Docker), with and
without a password; the containers through a simulated Docker engine. Not yet
on every NAS: feedback welcome on
[the issues](https://github.com/guim31/gladys-glances/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- On each machine to follow, Glances 3.x or 4.x started as a web server
  (`glances -w`), reachable from the Gladys machine (port 61208 by default).
- Up to three machines per installation of the integration.

The integration only reads: it never changes anything on your machines.

## Getting started

### 1. Start Glances in web server mode

On the machine to follow:

- installed with pip or your distribution: `glances -w` (as a service so it
  survives a reboot); add `--password` to protect it, Glances asks for the
  password once and can save it;
- with Docker: the `nicolargo/glances` image with `GLANCES_OPT="-w"`, port
  61208 published, and, to see the containers, the Docker socket mounted
  read-only (`-v /var/run/docker.sock:/var/run/docker.sock:ro`). To see the
  disks of the host, mount its root read-only (`-v /:/rootfs:ro`).

Check from a browser that `http://<machine address>:61208` shows Glances.

### 2. Configure the integration

In **Integrations → Glances → Configuration**:

- **Glances address**: `192.168.1.20`, `nas.lan`, or the address copied from
  your browser (`http://nas.lan:61208`); port 61208 is added when none is
  given;
- **User name (optional)** and **Password (optional)**: only if Glances was
  started with `--password` (the user name is `glances` unless Glances was
  started with `--username`);
- **Name (optional)**: the name shown in the devices, the widget and the
  messages; by default, the host name Glances gives (or the address when
  Glances runs in Docker and only knows its container id);
- the same for a **second** and a **third** server, if you have them;
- **Refresh interval**: 15 seconds to 5 minutes (30 seconds by default);
- **Accept self-signed certificates**: only for an `https://` address
  (Glances behind a reverse proxy) whose certificate is self-signed;
- **Language of the names**: the language of the feature names (set when a
  device is added), of the scene results and of the connection test (French
  by default).

**Test the connection** reads every server now and says what it found: the
Glances version, the number of disks, interfaces, sensors and running
containers.

### 3. Add the devices

Open the **Discover** tab: the integration proposes the server itself, then
each of its disks, network interfaces, temperature sensors and containers.
Add only what you want to follow: a NAS easily has thirty of them. The scene
triggers work for every disk, sensor and container, added or not.

## The devices

Values are rounded and sent only when they change; the ones that move all the
time (CPU, load, rates, temperatures, containers) at most once a minute.

### The server

| Feature             | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| Online              | On while Glances answers, Off after two silent reads     |
| CPU                 | Use of all the cores, in %                               |
| Memory              | Memory used, in %                                        |
| Swap                | Swap used, in % (when the machine has swap)              |
| Load (1 min)        | Load average over 1 minute                               |
| Load (5 min)        | Load average over 5 minutes                              |
| Load (15 min)       | Load average over 15 minutes                             |
| Uptime              | Time since the last boot, in days                        |
| Running containers  | Docker or Podman containers running (when there are any) |
| Highest temperature | The hottest temperature sensor, in °C                    |

### Disks

One device per mount point: **Space used** (%) and **Free space** (GB). The
files Docker binds into a Glances container and the system pseudo file
systems are left out. Glances 4 measures the disks once a minute.

### Network interfaces

One device per interface: **Download** and **Upload**, in Mbit/s. Loopback,
Docker bridges and virtual interfaces (`veth…`, `br-…`, `docker0`…) are left
out.

### Temperature sensors

One device per temperature sensor Glances reads (`Core 0`, `Package id 0`,
`Composite` for an NVMe drive…): **Temperature**, in °C.

### Containers

One device per container, kept when the container is recreated with the same
name (a `docker compose` update): **Running** (On/Off), **CPU** (%, one core
counts 100 %, like `docker stats`) and **Memory** (MB, page cache left out).
By default Glances only lists the running containers: a stopped container
disappears from Glances, and its device goes Off after two reads without it.
To list the stopped ones too, set `all=True` in the `[containers]` section of
`glances.conf`.

## Dashboard

Add the **Glances server** widget to a dashboard and choose the server in its
settings (any device of the server will do: the server itself, one of its
disks…). It shows:

- three gauges: **CPU**, **memory** and the **disk** (the root disk, or the
  disk device chosen in the settings), orange from 75 %, red from 90 %;
- the **highest temperature** (orange from 70 °C, red from 85 °C) and the
  number of **running containers** (red when one stopped);
- rows: the containers that stopped (in red, first), the free space of the
  disk, the swap, the load and the uptime;
- a server that does not answer, and why;
- a **Refresh** button that reads the server again.

## Scenes

### Triggers

They fire for every disk, sensor and container, added to Gladys or not. The
**Server** field narrows a trigger to one server (choose the device of the
server itself); leave it empty for all.

- **Disk almost full**: a disk reaches the chosen use (80, 85, 90, 95 or
  98 %). Once per step; again only after the disk went 2 points below it.
  Optional filter: one disk. Variables: server, mount point, space used (%),
  free space (GB), threshold.
- **High temperature**: a sensor stays at or above the chosen temperature (50
  to 100 °C) for two reads in a row. Again only after it went 5 °C below, and
  not twice within 30 minutes. Optional filter: one sensor. Variables:
  server, sensor, temperature, threshold.
- **Container stopped**: a container that was running stops, is paused or
  keeps restarting, on two reads in a row (a container recreated by an update
  is no stop). Optional filter: one container. Variables: server, container,
  state ("Stopped", "Paused", "Restarting").
- **Server unreachable**: a server no longer answers (two reads in a row, 15
  seconds apart). A refused password is not announced: the connection status
  shows it. Variables: server, reason.

Each threshold is a filter: one scene per threshold you care about. What was
announced is kept, so a restart of Gladys or of the integration neither
repeats an announcement nor misses one. A disk or a sensor already above a
threshold when it is seen for the first time announces nothing.

### Actions

- **State of a server**: reads a server for the next actions of the scene:
  name, answers (yes/no), CPU, memory and swap (%), load averages, uptime
  (days), main disk used (%) and free (GB), highest temperature, running and
  stopped containers, and a ready-made **summary** such as "NAS: CPU 12%,
  memory 45%, disk / 78% (110 GB free), 52 °C, 12 container(s) running". A
  server that does not answer is not an error: "answers" is no and the
  summary says why.

It reads the server again when the last read is older than 15 seconds.

### Scene ideas

- **Disk alert**: trigger "Disk almost full" with the threshold 90 % → send a
  message "💾 The disk … of … is at …%", inserting the variables "Mount
  point", "Server" and "Space used (%)".
- **Morning report**: every day at 8:00 → "State of a server" on the NAS →
  send the "Summary" output by message.
- **A service fell**: trigger "Container stopped" on the container of
  Nextcloud → send a message, or turn a light red.
- **Overheat**: trigger "High temperature" at 85 °C → send a message, switch
  on the fan of the server cupboard (a smart plug).

## Troubleshooting

- **"does not answer"**: Glances is not started in web server mode, the port
  is not 61208, or a firewall blocks it. Open `http://<address>:61208` from
  another machine.
- **"user name or password refused"**: check the password of
  `glances -w --password`, and the user name if Glances was started with
  `--username`.
- **"Glances asks for a password"**: Glances was started with `--password`;
  enter it in the configuration.
- **"no Glances web server (API 3 or 4) at this address"**: another service
  answers on that port, or Glances is older than 3.0.
- **No container in the Discover tab**: Glances does not see the container
  engine. In Docker, mount the Docker socket into the Glances container.
- **A disk is missing**: Glances hides `/boot` and `/snap`, and does not list
  tmpfs and network shares by default (see the `[fs]` section of
  `glances.conf`). In Docker, mount the host root (`-v /:/rootfs:ro`).
- **The CPU is missing right after Glances started**: Glances 4 measures
  nothing at its very first read; the value comes at the next one.

## Limits

- Read only: the integration starts or stops nothing, neither containers nor
  machines.
- Three servers at most per installation.
- The values of the devices that are not added are not sent to Gladys; the
  triggers and the widget still use them.
- A container removed for good is forgotten after a week.
- GPU, RAID, disk I/O, processes, fans and batteries are not read.
- Not affiliated with the Glances project.
