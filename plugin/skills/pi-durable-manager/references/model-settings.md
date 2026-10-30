# Connections and model profiles

Pi supports OpenAI-compatible **Chat Completions** endpoints on this Mac, another machine, or a hosted service. The server must support streaming and tool calls. API compatibility alone does not establish coding quality. llama.cpp, oMLX, Modal and similar servers can be configured by URL and model ID; each specific server/model/template combination still needs validation.

The browser's **Settings** tab is available alongside Progress and Terminal. It offers connection creation, model discovery, manual model IDs, profile creation, readiness tests, a global default and a project selector. Settings works without starting a worker. Model limits come from your server configuration. Compatibility overrides expose the validated Pi OpenAI-completions fields for server-specific differences.

Connections contain endpoint and authentication. Profiles contain connection, model ID, context/output limits, reasoning flag and compatibility overrides. Profiles and connections are immutable: add a replacement for a new endpoint, key or limits, then select it. This beta does not yet offer deletion, rename or in-place credential rotation. Unavailable credentials fail closed for that profile and do not prevent the preserved original connection from starting.

Selection order: explicit `workflow.submit.profileId` → saved project choice → default. New projects capture the default when created/imported; changing the default does not redirect existing projects. Existing projects migrate to the original profile. Sessions pin their profile, forks inherit it, and worker admission preserves it. A project switch requires no active/paused/unreviewed assignment. No automatic fallback or hot model switching occurs. Compaction reserves are calculated per profile, not inherited from the original model.

Legacy configurations retain their endpoint, credential reference, model, limits and DeepSeek defaults byte-for-byte. New guided installations explicitly use generic compatibility; DeepSeek-specific fields can be added in a replacement profile. No-auth inference sends the transport's non-secret placeholder bearer header. Remote HTTP requires an explicit insecure-transport opt-in; HTTPS is preferred.

## Manager operations

Discover exact descriptors with `service.capabilities`. `models.settings {projectId?}` returns only non-secret connection/profile metadata. `models.connection.add` accepts a key through the private Settings form, never chat or CLI arguments. `models.profile.add`, `models.default`, `models.project` require stable request IDs; receipts and mutations are atomic and replay-safe. `models.discover` allows manual IDs when discovery is unsupported. `models.test` performs a bounded real streaming tool-call/tool-result round trip using synthetic data and no filesystem tools. It records pass/fail, not a claim of full coding or wake acceptance.

First-use plugin setup installs the private runtime and asks for one endpoint/model, explicit context/output limits, optional authentication and worker networking. The first model becomes the default. Existing installation/configuration is never overwritten by onboarding.

The service holds credentials in memory and private files inside protected service state. Settings never returns credential bytes or references; settings receipts/journals contain only a digest of the request and safe results. The browser settings routes require exact Host/Origin, JSON, a per-viewer anti-CSRF token and a small allowlist. Ordinary terminal routes and observers remain read-only; Settings is deliberately a separate mutation surface.
