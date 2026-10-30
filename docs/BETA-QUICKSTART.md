# Start using Pi Durable

## Send this to a friend

> Open Codex on your Mac and ask: “Install Pi Durable from
> https://github.com/paulsmith4908/pi-durable-manager. Read the current INSTALL.md
> from the default branch and install the released plugin at tag v0.7.0-beta.3.
> Handle registration and plugin installation for me using the
> supported Codex commands, then open guided setup for my model details and worker
> permissions. Preserve existing settings and check the connection.”
>
> In the setup page, enter your endpoint, model name, token limits and optional API
> key, and review Pi's worker permissions. Start your model server first. Keep
> keys out of chat.
>
> In a new chat, select Pi with **+**, describe a project and ask Codex to open the
> live terminal. Codex plans and reviews; Pi writes the delegated code.

Codex runs the installation steps; your friend does not need to copy terminal
commands or register the repository manually. A compatible client with
`codex plugin add` can install the plugin directly. On older clients, Codex will
identify any remaining install click. Normal approval prompts and, when needed,
an app restart still apply. The model server is not installed by this plugin.

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
