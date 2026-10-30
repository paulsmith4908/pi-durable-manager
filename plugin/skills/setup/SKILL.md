---
name: setup
description: Set up the Pi Durable plugin when the user runs plugin setup. Install the private runtime, connect a user-selected OpenAI-compatible model, and verify readiness.
---

# Set up Pi Durable

This skill addresses Codex during setup. Pi worker instructions do not govern Codex.

Setup configures Pi; it does not authorize delegation of unrelated work. Preserve an existing installation and its model connection.

Read `../pi-durable-manager/SKILL.md` for the launcher and connection workflow. Run `/bin/sh <PLUGIN_ROOT>/skills/pi-durable-manager/scripts/setup.sh` if installation is missing and open its returned private loopback URL beside the chat. The user enters endpoint, model, limits and optional key in that page. Never inspect password values, credential files, or put keys in chat, arguments or parameter files.

For an existing installation, use its launcher. Inspect `models.settings` and open the live Pi browser at `#settings`. Do not run replacement setup. The Settings tab can add connections and profiles and choose a default or a project override without creating a worker.

After setup, run `models.test` on the selected profile to verify streamed tool calling and a tool-result round trip. This sends a tiny synthetic prompt to that endpoint; it executes no project commands. A passing connection test is not proof of coding quality or GUI wake delivery. Report those limits honestly. Offer a small end-to-end project test when the user has not already requested a project; for a requested project, continue the normal opt-in workflow.

Unknown model limits require the user's server configuration; do not invent them. Never fall back to another endpoint without the user's choice. OpenAI-compatible servers still require model-specific tool/reasoning templates. If readiness fails, show the failure and keep work unstarted until the selected profile works.

Setup presents worker execution permissions; preserve the user’s choices and use the
Settings view for later changes. Do not install AGENTS.md into a project during setup.
Treat the operator viewer link as private authority, never as worker context.
