# Runtime maintenance

Use the new plugin's `skills/pi-durable-manager/scripts/maintenance.mjs` with Node
22.19 or later. Supported actions are `inspect`, `upgrade`, `repair`, and `rollback`.
An optional `--data-home /absolute/path` selects a plugin installation outside the
default private data directory.

`inspect` reads version, installation and lease metadata. It does not expose secrets.
Before a mutation, settle workers, resolve uncertain commands and stop the idle
service. Maintenance deliberately refuses to cancel work or delete a live lock.

`upgrade` verifies the packaged payload and dependency lock, installs via
`npm ci --ignore-scripts`, checks database compatibility, takes a private backup,
and atomically switches `installation.json`. Reconnect explicitly afterward and
check service identity, model choice and permissions.

`repair` can reclaim a provably exited lock owner, quarantine an incomplete runtime
and repair an interrupted pointer switch without resetting configuration. An unknown
or live owner requires inspection. Structured error output identifies the failed
phase and code without echoing provider/npm output.

`rollback` selects the previous runtime only if it supports the existing schema. It
never overwrites current projects or state with an earlier backup. Incompatible
schemas require a separately reviewed migration. Private backups contain private
configuration/state and must never be added to a shared repository or diagnostic ZIP.

Supported commands target plugin-managed installations. Older development layouts
with a separate state/config/runtime location require a deliberate migration.
Refreshing the plugin alone does not update a running service.
