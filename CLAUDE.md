# QuickClaude

A Spotlight-style macOS launcher for Claude Code: ⌥Space opens a floating panel, a typed prompt gets a streamed answer, and ⌘↩ turns it into a chat. It runs the user's own Claude Code (subscription login, their CLAUDE.md, settings, MCP servers, skills) through the Claude Agent SDK. No API key.

The app lives in `quickclaude/`; run every command below from there.

## Deploy

When asked to deploy, run `./deploy.sh`. It builds the release app, stops any running copy (installed or `tauri dev`), installs `/Applications/QuickClaude.app`, adds a login item (`--no-login` skips it) and launches it. Report its final line, and check that only one copy is running afterwards: two copies fight over ⌥Space.

## Commands

- `npm run tauri dev`: dev build; runs `sidecar/agent.mjs` with node and hot-reloads the UI.
- `npm run tauri build -- --bundles app`: release build only, no install.
- `npm run build:agent`: compile the sidecar to `src-tauri/binaries/` with bun (runs automatically before dev and build).
- `npx tsc --noEmit -p .`: typecheck the UI.

## Layout

- `src-tauri/src/lib.rs`: Rust shell. Panel window, global hotkey, menu bar icon, hide on blur, spawns the sidecar and relays JSON lines between it and the UI (`agent_send` command, `agent` event). Restarts the sidecar if it dies.
- `sidecar/agent.mjs`: Agent SDK host. Keeps one Claude Code process pre-started with `startup()` so a new question skips start-up; follow-ups are pushed into the live session's input stream. Stdio protocol is documented at the top of the file.
- `src/App.tsx`, `src/App.css`: SolidJS UI. Compact view hugs its content; chat view is a fixed 640px panel. Markdown goes through DOMPurify.
- `deploy.sh`: build and install.

## Behaviour to preserve

- **Full Claude Code by default** (`QUICKCLAUDE_PROFILE=full`): `settingSources` user/project/local, the `claude_code` system prompt and tool presets, cwd `~/QuickClaude` (`QUICKCLAUDE_DIR`; history, resume, delete and ⌘T all use it, so ~'s chats stay out), and `bypassPermissions` to match the user's terminal. `lean` is a tool-less fast mode kept for comparison.
- **Subscription only**: the sidecar and the Rust shell both strip `ANTHROPIC_API_KEY`.
- **Uses the installed `claude`** (`pathToClaudeCodeExecutable`), not the SDK's bundled 248 MB copy, so the app tracks the terminal's version. The packaged app has no fallback copy.
- **Login-shell PATH**: apps launched from Finder or at login get a bare PATH, so the sidecar copies the PATH from `zsh -ilc` at start-up. Find executables by scanning PATH directories, not by calling `which` (it missed the updated PATH in the compiled binary).
- **Reopen behaviour**: after Esc, ⌥Space opens empty if the compact answer had finished; a running answer or a chat view is kept.
- **Keys**: ↩ new question (fresh session), ⌘↩ follow-up and switch to chat, ⇧↩ new line, ⌘. stop, ⌘N new chat, ⌘, preferences, ⌘T continue in a terminal: a new herdr workspace (`herdr workspace create` + `herdr pane run`) when herdr is running, else Ghostty, else Terminal.app. Tab cycles the model and ⇧Tab the effort (the label highlights the changed half, shows dots for the model's place, and the empty placeholder names the new choice). On an empty input, ↓ opens history; there ⇧↑↓, ⇧click, ⌘click and ⌘A select several chats (Esc drops the selection first), and ⌫ (on an empty search, or ⌘⌫ / forward delete) marks them and a second press deletes them from Claude Code (`deleteSession`). Esc, Tab, ⌘T, ⌘N and ⌘. also work when focus has left the input (e.g. after selecting chat text). Esc steps back: close the list, then clear the input, then close the chat back to an empty input (if it is still working it keeps running in the background), then hide.
- **Background work survives**: a chat counts as working while a turn runs, while Claude Code reports live background tasks (`background_tasks_changed`, non-ambient), and for up to 15 s after one ends (Claude Code then replies by itself). Leaving a working chat (Esc, ⌘N, a new question, opening another chat) parks its process instead of closing it; it closes once idle. Reopening a parked chat reuses that process. A reply that arrives on its own triggers a macOS notification unless that chat is on screen; clicking it opens the chat. Working chats get a green lamp in history. Esc on an expanded chat always goes back to an empty input (a working chat keeps running parked); ⌘T is blocked while working (moving would kill the tasks).
- **Away alerts**: whenever a chat fully finishes (no background work left) the sidecar emits `notify`; the Rust shell ignores it if that chat is on screen, otherwise it follows the ⌘, preferences (`~/Library/Application Support/QuickClaude/settings.json`): play `src-tauri/sounds/reply.mp3` (Pixabay "New Notification 3", bundled as a resource, played with `afplay`), bring the panel forward with that chat (only if the panel is hidden, so it never pulls you out of another chat), or show a notification (skipped when it comes forward). ⌘, or the menu bar's "Preferences…" opens the settings screen.
- **Model choice**: only the latest alias of each family, at medium or high effort. The last pick is saved by the sidecar in `~/Library/Application Support/QuickClaude/choice.json` (shared by dev and installed copies); without it, the user's Claude Code settings decide.

## Gotchas

- Release builds run `Contents/MacOS/quickclaude-agent`; dev builds run node on the source file. The dev path is compiled in from `CARGO_MANIFEST_DIR`, so rebuild after moving the folder.
- When stopping processes, match exact paths (`/Applications/QuickClaude.app/Contents/MacOS/`, `target/debug/quickclaude$`). Never use broad patterns like `pkill -f vite`; they kill the user's other dev servers.
- Don't drive the UI with simulated keystrokes while the user is at the Mac. A menu bar app never reports as the frontmost process, so focus can't be confirmed, and stray keys land in other apps.
- Starting a new spare process right after an answer briefly slows an immediate next question (about 1.5 s extra for a few seconds).

## Known gaps

- A regular window, not an `NSPanel`; it doesn't appear over full-screen apps.
- No syntax highlighting.
- Tool calls show only a "Using <tool>…" line, not their input or output.
- Hotkey and profile are env vars only (`QUICKCLAUDE_HOTKEY`, `QUICKCLAUDE_PROFILE`, `QUICKCLAUDE_MODEL`), which an app launched from Finder doesn't see.
