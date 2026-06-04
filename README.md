# Copilot CLI Telegram MCP

An always-on Telegram bot that routes your messages to **GitHub Copilot CLI** and streams responses back — with dynamic skill injection, conversation archiving, and a Hermes queue bridge.

## Features

- Send tasks to Copilot CLI directly from Telegram
- Dynamic skill injection — top matching skills are auto-loaded per message
- Conversation archive with daily summaries and `recall` command
- Hermes queue bridge — Hermes (Overmind) can delegate tasks via `.copilot-queue.json`
- Session continuity via context-prefix injection (Copilot CLI is stateless)

## Prerequisites

- Node.js 18+
- GitHub Copilot CLI installed and authenticated (`gh copilot`)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Telegram Chat ID

## Installation

```bash
git clone https://github.com/TopSpeed0/Copilot-CLI-Telegram-MCP.git
cd Copilot-CLI-Telegram-MCP
npm install
```

## Configuration

Create `.telegram-config` in the repo root (gitignored):

```json
{
  "bot_token": "your_telegram_bot_token",
  "chat_id": "your_telegram_chat_id",
  "skills_dir": "C:/Users/<you>/.claude/skills"
}
```

Or use environment variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
SKILLS_DIR=/path/to/skills
```

## Usage

```bash
node mcp/copilot-task-daemon.js
```

Or via PowerShell launcher:

```powershell
.\mcp\start-copilot-daemon.ps1
```

### Special commands (in Telegram)

- `recall` — show the last archived conversation
- `recall 5` — show the last 5 archived turns

## Skills

Skills are Markdown files with YAML frontmatter (`SKILL.md`) that describe when to trigger. The daemon scores each skill against your message and injects the top-N most relevant ones as context.

Default skills directory: `~/.claude/skills/`
Override via `skills_dir` in `.telegram-config` or `SKILLS_DIR` env var.

## Hermes Queue Bridge

Hermes can delegate tasks to Copilot by writing to `.copilot-queue.json`:

```json
{
  "id": "task-001",
  "task": "your task description",
  "status": "pending"
}
```

The daemon picks it up, runs it through Copilot CLI, and writes back `"status": "done"` with a `"result"` field.

## License

MIT
