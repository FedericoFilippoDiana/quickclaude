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

- **Full Claude Code by default** (`QUICKCLAUDE_PROFILE=full`): `settingSources` user/project/local, the `claude_code` system prompt and tool presets, cwd `~`, and `bypassPermissions` to match the user's terminal. `lean` is a tool-less fast mode kept for comparison.
- **Subscription only**: the sidecar and the Rust shell both strip `ANTHROPIC_API_KEY`.
- **Uses the installed `claude`** (`pathToClaudeCodeExecutable`), not the SDK's bundled 248 MB copy, so the app tracks the terminal's version. The packaged app has no fallback copy.
- **Login-shell PATH**: apps launched from Finder or at login get a bare PATH, so the sidecar copies the PATH from `zsh -ilc` at start-up. Find executables by scanning PATH directories, not by calling `which` (it missed the updated PATH in the compiled binary).
- **Reopen behaviour**: after Esc, ⌥Space opens empty if the compact answer had finished; a running answer or a chat view is kept.
- **Keys**: ↩ new question (fresh session), ⌘↩ follow-up and switch to chat, ⇧↩ new line, ⌘. stop, ⌘N new chat, ⌘T continue in a terminal (Ghostty). Tab cycles the model and ⇧Tab the effort (the label highlights the changed half, shows dots for the model's place, and the empty placeholder names the new choice). On an empty input, ↓ opens history. Esc steps back: close the list, then clear the input, then collapse the chat and hide.
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
