# Glances fixtures

Real answers of the Glances REST API, recorded on 13/10/2026 from the official
Docker images, one file per plugin (`GET /api/<v>/<plugin>`):

- `v4/`: `nicolargo/glances:4.5.8-full`, host name `nas`, started with
  `GLANCES_OPT="-w"` and a `glances.conf` setting `[fs] allow=tmpfs` (two tmpfs
  volumes, `/mnt/data` and `/srv/backup`, stand for data disks) and
  `[containers] all=True` (stopped containers listed).
- `v3/`: `nicolargo/glances:3.4.0.5-full`, host name `homeserver`, same
  settings.
- `v4-default/containers.json`, `v3-default/containers.json`: the same
  containers with the default settings (running containers only).
- `v4-first-read-cpu.json`: the `cpu` plugin of a Glances 4 at its very first
  read (zeros everywhere).

The containers come from a minimal simulated Docker Engine API (a unix socket
shared with the Glances containers), not from the Docker of the recording
machine: Glances itself built these answers (names, health status, CPU and
memory computed from the stats stream). The only edit: the mount point
`/run/fakedocker` of that socket was renamed `/srv/media`. Nothing private:
addresses and container ids are those of throw-away test containers.

`glances-api.json`: the `RESPONSE` (API v3, `/all`) and `RESPONSE_V4` (API v4,
`/all`, partial) fixtures of
[glances-api](https://github.com/home-assistant-ecosystem/python-glances-api)
(`tests/test_responses.py`, MIT, Fabian Affolter), plus the unreadable sensor
(`"unavailable"`) of the Home Assistant `glances` tests.
