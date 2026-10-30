# Connections and model profiles

Pi supports OpenAI-compatible **Chat Completions** endpoints on this Mac, another machine, or a hosted service. The server must support streaming and tool calls. API compatibility alone does not establish coding quality. llama.cpp, oMLX, Modal and similar servers can be configured by URL and model ID; each specific server/model/template combination still needs validation.

The browser's **Settings** tab is available alongside Progress and Terminal. It offers connection creation, model discovery, manual model IDs, profile creation, readiness tests, a global default and a project selector. Settings works without starting a worker. Model limits come from your server configuration. Compatibility overrides expose the validated Pi OpenAI-completions fields for server-specific differences.

Connections contain endpoint and authentication. Profiles contain connection, model ID, context/output limits, reasoning flag and compatibility overrides. Model profiles and endpoint addresses are immutable: add a replacement for a different endpoint, model or limits. Saved providers can be renamed. Added providers support credential rotation and disabling from Settings; both require no worker using that provider to hold a lease. Disabling also requires choosing a different default first. Historical profiles remain for attribution and are not silently redirected. The original externally configured connection is preserved; replace it explicitly instead of rotating or disabling it here. Unavailable credentials fail closed for that profile and do not prevent the preserved original connection from starting.

Selection order: explicit `workflow.submit.profileId` → saved project choice → default. New projects capture the default when created/imported; changing the default does not redirect existing projects. Existing projects migrate to the original profile. Sessions pin their profile, forks inherit it, and worker admission preserves it. A project switch requires no active/paused/unreviewed assignment. No automatic fallback or hot model switching occurs. Compaction reserves are calculated per profile, not inherited from the original model.

Legacy configurations retain their endpoint, credential reference, model, limits and DeepSeek defaults byte-for-byte. New guided installations explicitly use generic compatibility; DeepSeek-specific fields can be added in a replacement profile. No-auth inference sends the transport's non-secret placeholder bearer header. Remote HTTP requires an explicit insecure-transport opt-in; HTTPS is preferred.

## Manager operations

Discover exact descriptors with `service.capabilities`. `models.settings {projectId?}` returns only non-secret connection/profile metadata. `models.connection.add` accepts a key through the private Settings form, never chat or CLI arguments. `models.profile.add`, `models.default`, `models.project` require stable request IDs; receipts and mutations are atomic and replay-safe. `models.discover` allows manual IDs when discovery is unsupported. `models.test` performs a bounded real streaming tool-call/tool-result round trip using synthetic data and no filesystem tools. It records pass/fail, not a claim of full coding or wake acceptance.

First-use plugin setup installs the private runtime and asks for one endpoint/model, explicit context/output limits, optional authentication and worker networking. The first model becomes the default. Existing installation/configuration is never overwritten by onboarding.

The service holds credentials in memory and private files inside protected service state. Settings never returns credential bytes or references; settings receipts/journals contain only a digest of the request and safe results. The browser settings routes require a private operator capability plus exact Host/Origin, JSON, an anti-CSRF token and a small allowlist. The ordinary observer URL cannot obtain this capability. Codex opens the private operator URL directly; it must never be placed in worker instructions or public logs. The browser retains it in tab-scoped session storage across refresh and removes it from the address bar. Ordinary terminal routes and observers remain read-only; Settings is deliberately a separate mutation surface.


Credential rotation records a new revision, invalidates previous readiness evidence and
uses a durable cleanup queue for the prior owned key. Startup and idempotent retries
clean orphaned staged keys. If the OS prevents deletion, Settings reports pending
cleanup; disabling access still takes effect. Changing or disabling a connection
during a readiness check prevents that check from marking the new state verified.
This deletes a local saved credential, not the remote provider's API key itself.

## Worker permissions

Settings → Worker permissions controls editing, shell commands, development networking,
configured host validation, and additional excluded paths. Choose the global default
or a project override. Shell requires editing because arbitrary shell execution cannot
be promised read-only. Each assignment records an immutable policy revision. Changes
are refused while the affected project has a writer lease; changing the global default
conservatively requires all writers to be settled.

The service always protects Git metadata, manager state and common secret filenames,
including nested paths. Filename rules cannot recognize every possible secret. Exclude
sensitive project files explicitly before delegating. Shell plus networking is broad
execution authority, not a per-command or external-action allowlist. Git releases and
other privileged actions stay with the separately authorized manager in this beta.
Setup presents these permissions; existing installations preserve their choices.
AGENTS.md is never created, deleted or rewritten automatically.
