# QuickClaude

A Spotlight-style launcher for Claude Code on macOS. Press **⌥Space** anywhere, type a question, and the answer streams into a small floating panel. Need more than one answer? Turn it into a chat, or carry the conversation over to your terminal and keep going there.

It runs your own Claude Code with your Claude subscription, in its own `~/QuickClaude` folder, so it knows your settings, your `CLAUDE.md`, your MCP servers and your skills. No API key needed.

## Why I built it

Most of my questions for Claude are quick ones, but asking meant switching to a terminal, starting Claude Code and waiting for it to load. I wanted Claude Code one keystroke away, the way Spotlight is: ask, read, dismiss, back to what I was doing. When a quick question turns into a real task, I want to pick it up in the terminal without starting over.

## Using it

- **⌥Space** shows or hides the panel. It opens on a new chat, unless a reply you haven't seen is waiting.
- **↩** asks, continuing the chat on screen. **⌘N** starts a new chat.
- **Space** on a new, empty chat opens your last chat; **Space Space** opens all your chats. Click the spark (or **↓**) for all your chats.
- **Tab** switches the model, **⇧Tab** switches the effort. Your choice is remembered.
- **↓** on an empty input browses your past QuickClaude chats. Select several with **⇧↑↓**, **⇧click**, **⌘click** or **⌘A**, and press **⌫** twice to delete them.
- **⌘V** pastes an image into the question.
- **⌘T** continues the conversation in your terminal: as a new [herdr](https://herdr.dev) workspace if herdr is running, otherwise in a new Ghostty or Terminal window.
- **⌘,** opens preferences: a sound, a notification, or bringing the chat forward when a reply finishes while you're away.
- **Esc** steps back: closes a list, clears the input, then hides the panel.

## What you need

- A Mac with Apple silicon
- [Claude Code](https://claude.com/claude-code), signed in with your Claude subscription
- [Node.js](https://nodejs.org)
- [Bun](https://bun.sh)
- [Rust](https://rustup.rs)
- Optional: [herdr](https://herdr.dev) or [Ghostty](https://ghostty.org) for the terminal hand-off (it falls back to Terminal.app)

## Develop

From the `quickclaude` folder:

```bash
npm install
(cd sidecar && npm install)
npm run tauri dev
```

The panel opens with ⌥Space and reloads as you edit the UI.

## Deploy

From the `quickclaude` folder:

```bash
./deploy.sh
```

This builds the app, installs it to `/Applications/QuickClaude.app`, adds it to your login items and starts it. Use `./deploy.sh --no-login` to skip the login item. Stop the dev build first, or let the script do it, because two copies fight over ⌥Space.
