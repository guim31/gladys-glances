# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the Glances passwords are `secret` fields of the Gladys
  configuration. The integration reads them from Gladys at startup, keeps them
  in memory, sends them only to the Glances server they belong to (HTTP Basic
  credentials of its REST API), and never writes them to `/data` nor to the
  logs. The Glances API is read only: a password of Glances opens nothing
  else on the machine.
- **Stored in `/data`**: `glances-state.json`, what the scene triggers compare
  with: the containers seen running (names and timestamps), the disks
  (mount points) and temperature sensors (labels) whose thresholds were
  already announced. No address, no figure, no secret.
- **Network**: requests go only to the Glances addresses typed in the
  configuration, in HTTP or HTTPS. HTTPS certificates are verified unless the
  user ticks "Accept self-signed certificates"; the integration opens no port
  and calls no cloud service. Glances itself serves its API in clear HTTP:
  keep it on the local network, or behind an HTTPS reverse proxy.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Glances itself (see its
[security policy](https://github.com/nicolargo/glances/security/policy)), and
the machines it monitors.
