# Copilot CLI — Telegram Bridge

![License](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg?logo=node.js&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)
![GitHub Copilot](https://img.shields.io/badge/GitHub%20Copilot-CLI%20Bridge-000000.svg?logo=github&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4.svg?logo=telegram&logoColor=white)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4.svg)

An always-on Telegram bot that routes your messages to **GitHub Copilot CLI** and streams responses back. Send tasks, receive completions, and get remote approvals — all from your phone.

## What's Included

| File | Purpose |
|------|---------|
| `mcp/copilot-task-daemon.js` | Always-on bridge: Telegram messages → `copilot -p` tasks |
| `mcp/start-copilot-daemon.ps1` | Launcher with auto-restart (foreground or background) |
| `mcp/install-shortcuts.ps1` | Windows Start Menu + Desktop shortcut creator |

## Installation

### Prerequisites

Install all three in any order — one line each:

| Tool | Windows | macOS / Linux |
|------|---------|---------------|
| Node.js 22+ | `winget install OpenJS.NodeJS.LTS` | `curl -fsSL https://fnm.vercel.app/install \| bash && fnm install --lts` |
| GitHub CLI | `winget install GitHub.cli` | `brew install gh` |
| Copilot CLI | `gh extension install github/gh-copilot` | `gh extension install github/gh-copilot` |

After installing, authenticate: `gh auth login` then `gh copilot -h` to verify.

### One-Prompt Install

Copy-paste this single block — it clones the repo and opens the config:

**Windows (PowerShell):**

```powershell
git clone https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP.git; cd Copilot-CLI-Telegram-MCP; Copy-Item .telegram-config.example .telegram-config
```

**macOS / Linux (bash):**

```bash
git clone https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP.git && cd Copilot-CLI-Telegram-MCP && cp .telegram-config.example .telegram-config
```

After cloning, edit `.telegram-config` with your credentials:

```json
{
  "bot_token": "your_telegram_bot_token",
  "chat_id": "your_telegram_chat_id",
  "skills_dir": "~/.claude/skills"
}
```

### Start the Daemon

```powershell
# Foreground — see logs live
.\mcp\start-copilot-daemon.ps1

# Background — detached, logs to mcp/copilot-daemon.log
.\mcp\start-copilot-daemon.ps1 -Background
```

## Getting Your Telegram Credentials

1. **Bot Token:** Message [@BotFather](https://t.me/botfather) on Telegram, create a new bot, copy the token
2. **Chat ID:** Send any message to your bot, then open:

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

Find `"chat":{"id":` in the response — that number is your chat ID.

## How It Works

### Task Daemon (`copilot-task-daemon.js`)

Runs independently, long-polling Telegram for messages. Each message becomes a `copilot -p` invocation. The daemon:

- Maintains session continuity via context-prefix injection (Copilot CLI is stateless)
- Injects the top-N most relevant **skills** as context per message
- Chunks long output to fit Telegram's 4096-char message limit
- Strips ANSI codes for clean monospace display

### Dynamic Skill Injection

Skills are Markdown files (`SKILL.md`) with YAML frontmatter that describe **when to trigger**. The daemon scores each skill against your message by token overlap and injects the top-N most relevant ones as context.

Default skills directory: `~/.claude/skills/`
Override via `skills_dir` in `.telegram-config` or `SKILLS_DIR` env var.

### Special Commands

- `recall` — show the last archived conversation turn
- `recall 5` — show the last 5 archived turns

## Hermes Overmind Integration

This repo is part of a **three-worker architecture** with [Hermes Agent](https://hermes-agent.nousresearch.com/) as the Overmind:

```
You (Telegram)
    │
    ▼
Hermes Agent — Overmind (always-on, owns Telegram)
    ├── General tasks → handles directly
    ├── Coding/generic tasks → .copilot-queue.json → Copilot CLI daemon (this repo)
    └── Heavy/workspace tasks → .claude-queue.json → Claude Code daemon
                                → TopSpeed0/ClaudeCodeTelgMCP
```

| Repo | Worker | Queue file | Best for |
|------|--------|------------|----------|
| [AI-MCP-telegram-agents](https://github.com/TopSpeed0/AI-MCP-telegram-agents) | VS Code Copilot Agent (v1 foundation) | `.vscode-queue.json` | VS Code-integrated workflows |
| **This repo** | Copilot CLI daemon | `.copilot-queue.json` | Generic tasks, any directory |
| [ClaudeCodeTelgMCP](https://github.com/TopSpeed0/ClaudeCodeTelgMCP) | Claude Code daemon | `.claude-queue.json` | Heavy reasoning, workspace tools |

### Generic + Local design

Each daemon works in **two modes simultaneously** — no config switch needed:
- **Standalone**: receives Telegram messages directly → runs `copilot -p` → replies to Telegram
- **Hermes worker**: polls `.copilot-queue.json` every 5s → picks up `pending` tasks → writes result back

Hermes writes tasks to `.copilot-queue.json` in the repo root:

```json
{
  "id": "task-001",
  "task": "Check disk usage on the NetApp cluster",
  "status": "pending",
  "created": "2025-01-15T10:00:00.000Z"
}
```

The daemon sets `status: "done"` and writes back — Hermes picks it up and delivers it to the user.

## Requirements

- GitHub Copilot CLI installed and authenticated (`gh copilot`)
- Node.js 18+ (22+ if you need `--use-system-ca` for corporate TLS)
- PowerShell 7+ (for the launcher and shortcut scripts)
- A Telegram bot token + your chat ID

## License

MIT
