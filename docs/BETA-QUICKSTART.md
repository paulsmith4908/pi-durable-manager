# Start using Pi Durable

## Send this to a friend

> Open Codex on your Mac and give it this repository link. Ask: “Install the
> Pi Durable plugin. Follow INSTALL.md and open guided setup for my model server.”
> Install Pi from the **Pi Durable Beta** source in the Plugins Directory when
> prompted. You may need to restart the app once.
>
> In the setup page, enter your endpoint, model name, token limits and optional API
> key. Start your model server first. Keep keys out of chat.
>
> In a new chat, select Pi with **+**, describe a project and ask Codex to open the
> live terminal. Codex plans and reviews; Pi writes the delegated code.

Replace “this repository link” with the real repository URL after publishing.
For a private beta without GitHub, send the repository ZIP and SHA256SUMS; a friend
can extract it and give Codex the extracted folder instead.

## What you need

- A Mac with Git and a compatible Codex desktop app. Setup checks plugin/local
  execution and native queue support; generic Codex CLI access alone is insufficient.
- An OpenAI-compatible Chat Completions endpoint with streaming/tool calling.
  Localhost, a LAN server (explicit HTTP opt-in), and HTTPS hosting are supported.
- Your model ID, configured context/output limits, and API key if required.
- Internet for installation dependencies. A private Node can be installed if needed.

The model server is separate: run llama.cpp, oMLX, Modal or your preferred server
before setup. Some model/server combinations need specific tool or reasoning
settings. The connection test will report problems rather than switch providers.

## After setup

**Progress** shows the roadmap and recent work. **Terminal** shows the same worker's
recorded Pi output. **Settings** lets you add providers and models at any time.
Changing the default affects new projects; existing projects and sessions retain
their choices unless deliberately changed.

First try the short question/answer acceptance task in [INSTALL.md](../INSTALL.md).
Your Mac must be awake for timely work and wake delivery. The service is independent
of the viewer, and no login item is installed. After restarting the Mac, ask Codex
to reconnect through Pi.

Installation does not delegate every task. Select Pi or say “Use Pi” for work you
want delegated; otherwise Codex handles it. Nothing is automatically published.

This is a beta tested on the development Mac, not yet a second physical Mac. Read
[known limits](../README.md#requirements-and-limits) and report a failing step with
its version and redacted error, never a key or full private configuration.
