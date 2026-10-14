// QuickClaude agent sidecar.
//
// Speaks JSON lines over stdio with the Tauri shell:
//   in:  {type:"hello"}                                  re-send models (UI reloaded)
//        {type:"ask", text, images?, followUp, turn, model, effort}
//        {type:"stop"} | {type:"reset"}
//        {type:"history"}                                list past sessions
//        {type:"open", id, turn}                         reopen a past session
//        {type:"handoff"}                                continue the session in a terminal
//        {type:"choice", model, effort}                  remember the picked model and effort
//   out: {type:"ready"} | {type:"models", models, defaultModel, defaultEffort, chosen} | {type:"session", id}
//        {type:"delta", turn, text} | {type:"tool", turn, name} | {type:"done", turn, ...}
//        {type:"history", sessions} | {type:"transcript", id, turn, messages}
//        {type:"handoff", id} | {type:"error", turn?, message}
//
// Auth comes from the local `claude` login (your Claude subscription).
// A spare session is always open and waiting, so a new question never pays
// process start-up.

import { getSessionMessages, listSessions, query, startup } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

// "full" mirrors your terminal Claude Code; "lean" is the fast, tool-less answer box.
const PROFILE = process.env.QUICKCLAUDE_PROFILE ?? "full";
const MODEL = process.env.QUICKCLAUDE_MODEL; // unset: whatever your Claude Code settings use

// Apps opened from Finder or at login get a bare PATH. Borrow the login shell's,
// so Bash commands and MCP servers find the same tools as in your terminal.
try {
  const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__PATH__%s" "$PATH"'], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const path = out.split("__PATH__").pop();
  if (path) process.env.PATH = path;
} catch {}

// Run your installed `claude`, so the app matches your terminal's version and updates.
function findClaude() {
  if (process.env.QUICKCLAUDE_CLAUDE) return process.env.QUICKCLAUDE_CLAUDE;
  // Falls back to the SDK's bundled copy (dev only; the packaged app doesn't include it).
  return (process.env.PATH ?? "")
    .split(":")
    .map((dir) => join(dir, "claude"))
    .find((file) => existsSync(file));
}
const CLAUDE = findClaude();

// Never let an API key in the environment override the subscription login.
const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "quickclaude/0.1.0" };
delete env.ANTHROPIC_API_KEY;

const LEAN_PROMPT = `You are QuickClaude, a fast desktop assistant summoned with a hotkey.
Answer directly and concisely; lead with the answer, then only the detail that helps.
Use Markdown when it aids reading (code blocks, short lists, tables).
Use web search only when the question needs current or niche facts.
Today's date is ${new Date().toDateString()}.`;

const LEAN_DIR = join(HOME, ".quickclaude");
mkdirSync(LEAN_DIR, { recursive: true });

const OPTIONS =
  PROFILE === "lean"
    ? {
        cwd: LEAN_DIR,
        settingSources: [], // no CLAUDE.md / settings / MCP: faster, predictable
        systemPrompt: LEAN_PROMPT,
        tools: ["WebSearch", "WebFetch"],
        allowedTools: ["WebSearch", "WebFetch"],
      }
    : {
        // Same as running `claude` in your home folder: your CLAUDE.md, settings,
        // MCP servers, skills, Claude Code's own system prompt and full tool set.
        // Permissions mirror your settings (bypassPermissions), so nothing is asked.
        cwd: HOME,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };
Object.assign(
  OPTIONS,
  { env, includePartialMessages: true },
  MODEL && { model: MODEL },
  CLAUDE && { pathToClaudeCodeExecutable: CLAUDE },
);

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// --- sessions -------------------------------------------------------------

function inputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(content) {
      items.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// A session is an open Claude Code process waiting on its input queue.
// New sessions come from a pre-started process; resumed ones start cold.
async function createSession(resume) {
  const input = inputQueue();
  const q = resume
    ? query({ prompt: input, options: { ...OPTIONS, resume } })
    : (await startup({ options: OPTIONS })).query(input);
  return {
    input,
    q,
    id: resume ?? null,
    turn: 0,
    hadText: false,
    model: "", // "" = your default
    effort: "", // "" = the model's default
    close() {
      input.close();
      q.close();
    },
  };
}

let spare = null; // Promise<session>
let current = null; // session
let seq = 0; // bumps on every switch, so a slow start can tell it was superseded
let models = null;

function warmSpare() {
  spare = createSession();
  spare.catch((e) => {
    spare = null;
    emit({ type: "error", message: `Warm-up failed: ${e.message}` });
  });
}

function takeSpare() {
  const pending = spare ?? createSession();
  spare = null;
  return pending;
}

function activate(s) {
  current?.close();
  current = s;
  pump(s);
}

// Bring the session's model and effort in line with the picker before sending.
async function configure(s, model, effort) {
  if (model !== undefined && model !== s.model) {
    await s.q.setModel(model || undefined);
    s.model = model;
  }
  if (effort !== undefined && effort !== s.effort) {
    await s.q.applyFlagSettings({ effortLevel: effort || null });
    s.effort = effort;
  }
}

function content(text, images) {
  if (!images?.length) return text;
  const blocks = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  return text ? [...blocks, { type: "text", text }] : blocks;
}

async function ask({ text, images, followUp, turn, model, effort }) {
  let s = followUp ? current : null;
  if (!s) {
    const mine = ++seq;
    current?.close();
    current = null;
    try {
      s = await takeSpare();
    } catch (e) {
      emit({ type: "error", turn, message: e.message });
      return;
    }
    if (mine !== seq) return s.close(); // another question or session replaced this one
    activate(s);
  }
  s.turn = turn;
  try {
    await configure(s, model, effort);
  } catch (e) {
    emit({ type: "error", message: `Couldn't switch model/effort: ${e.message}` });
  }
  s.input.push(content(text, images));
}

async function pump(s) {
  try {
    for await (const m of s.q) {
      if (s !== current) return;
      if (m.type === "system" && m.subtype === "init") {
        s.id = m.session_id;
        emit({ type: "session", id: s.id });
      } else if (m.type === "stream_event" && !m.parent_tool_use_id) {
        const ev = m.event;
        if (ev.type === "content_block_start") {
          const block = ev.content_block;
          if (block.type === "text" && s.hadText) {
            emit({ type: "delta", turn: s.turn, text: "\n\n" });
          } else if (block.type === "tool_use" || block.type === "server_tool_use") {
            emit({ type: "tool", turn: s.turn, name: block.name });
          }
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          s.hadText = true;
          emit({ type: "delta", turn: s.turn, text: ev.delta.text });
        }
      } else if (m.type === "result") {
        emit({
          type: "done",
          turn: s.turn,
          isError: m.is_error,
          error: m.subtype === "success" ? null : (m.errors ?? []).join("\n") || m.subtype,
          result: m.subtype === "success" ? m.result : null,
          durationMs: m.duration_ms,
          costUsd: m.total_cost_usd,
        });
        s.hadText = false;
        // Start the next spare once this answer is out, so it never competes with it.
        if (!spare) warmSpare();
      }
    }
  } catch (e) {
    if (s === current) emit({ type: "error", turn: s.turn, message: e.message });
  }
}

// --- history --------------------------------------------------------------

async function history() {
  try {
    const sessions = await listSessions({ dir: HOME, includeWorktrees: false });
    emit({
      type: "history",
      sessions: sessions
        .sort((a, b) => b.lastModified - a.lastModified)
        .slice(0, 300)
        .map((s) => ({
          id: s.sessionId,
          title: s.customTitle || s.summary || s.firstPrompt || "(untitled)",
          at: s.lastModified,
        })),
    });
  } catch (e) {
    emit({ type: "error", message: `Couldn't read history: ${e.message}` });
  }
}

// Claude Code stores harness notes as user messages; keep only what a person typed.
const NOISE = /^(<command-|<local-command-|<system-reminder>|Caveat: )/;

function toChat(messages) {
  const chat = [];
  for (const m of messages) {
    if (m.parent_tool_use_id || (m.type !== "user" && m.type !== "assistant")) continue;
    const c = m.message?.content;
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    const text = blocks
      .filter((b) => b.type === "text" && !NOISE.test(b.text))
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    const images = blocks.filter((b) => b.type === "image").length;
    if (!text && !images) continue;
    const prev = chat[chat.length - 1];
    if (m.type === "assistant" && prev?.role === "assistant") prev.text += `\n\n${text}`;
    else chat.push({ role: m.type, text, images });
  }
  return chat;
}

async function open({ id, turn }) {
  const mine = ++seq;
  current?.close();
  current = null;
  try {
    const messages = await getSessionMessages(id, { dir: HOME });
    if (mine !== seq) return;
    emit({ type: "transcript", id, turn, messages: toChat(messages) });
    const s = await createSession(id);
    if (mine !== seq) return s.close();
    s.turn = turn;
    activate(s);
  } catch (e) {
    emit({ type: "error", turn, message: `Couldn't open that chat: ${e.message}` });
  }
}

// --- terminal handoff -------------------------------------------------------

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function openTerminal(command) {
  const shell = process.env.SHELL || "/bin/zsh";
  // Run claude in a login shell, then leave you in that shell when it exits.
  const script = `${command}; exec ${shell} -l`;
  if (existsSync("/Applications/Ghostty.app")) {
    spawn("open", ["-na", "Ghostty.app", "--args", `--working-directory=${HOME}`, "-e", shell, "-lc", script], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    const cmd = `cd ${shellQuote(HOME)} && ${script}`;
    const as = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    spawn("osascript", ["-e", as], { detached: true, stdio: "ignore" }).unref();
  }
}

async function handoff() {
  const s = current;
  if (!s?.id) {
    emit({ type: "error", message: "Ask something first; there's no session to continue yet." });
    return;
  }
  // Close our process first so the terminal is the only one writing to the session.
  ++seq;
  current = null;
  s.close();
  await new Promise((r) => setTimeout(r, 300));
  const flags = [
    `--resume ${s.id}`,
    s.model && `--model ${shellQuote(s.model)}`,
    s.effort && `--effort ${shellQuote(s.effort)}`,
  ].filter(Boolean);
  openTerminal(`claude ${flags.join(" ")}`);
  emit({ type: "handoff", id: s.id });
}

// --- stdin loop -----------------------------------------------------------

createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.type === "ask") ask(cmd);
  else if (cmd.type === "stop") current?.q.interrupt().catch(() => {});
  else if (cmd.type === "reset") {
    ++seq;
    current?.close();
    current = null;
  } else if (cmd.type === "hello") models && emitModels();
  else if (cmd.type === "history") history();
  else if (cmd.type === "open") open(cmd);
  else if (cmd.type === "handoff") handoff();
  else if (cmd.type === "choice") saveChoice(cmd);
});

process.stdin.on("end", () => {
  current?.close();
  spare?.then((s) => s.close(), () => {});
  setTimeout(() => process.exit(0), 200);
});

// The picker offers only the latest model of each family, at medium or high effort.
const EFFORTS = ["medium", "high"];

function userEffort() {
  try {
    const level = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8")).effortLevel;
    return EFFORTS.includes(level) ? level : "high";
  } catch {
    return "high";
  }
}

// The last picked model and effort, kept across restarts (shared by dev and installed copies).
const CHOICE_DIR = join(HOME, "Library", "Application Support", "QuickClaude");
const CHOICE_FILE = join(CHOICE_DIR, "choice.json");

function savedChoice() {
  try {
    return JSON.parse(readFileSync(CHOICE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveChoice({ model, effort }) {
  try {
    mkdirSync(CHOICE_DIR, { recursive: true });
    writeFileSync(CHOICE_FILE, JSON.stringify({ model, effort }));
  } catch {}
}

// Defaults are the saved choice when it's still offered, else your Claude Code settings.
function emitModels() {
  const { model, effort } = savedChoice();
  const m = models.models.find((x) => x.value === model);
  emit({
    type: "models",
    models: models.models,
    defaultModel: m ? m.value : models.defaultModel,
    defaultEffort: m?.efforts.includes(effort) ? effort : models.defaultEffort,
    chosen: existsSync(CHOICE_FILE),
  });
}

function pickerModels(all) {
  // Aliases ("opus", "sonnet", …) always point at the newest model of their family.
  const latest = all.filter((m) => m.value !== "default" && !m.value.startsWith("claude-"));
  const def = all.find((m) => m.value === "default");
  const defaultModel =
    latest.find((m) => m.resolvedModel === def?.resolvedModel)?.value ?? latest[0]?.value ?? "";
  return {
    models: latest.map((m) => ({
      value: m.value,
      name: m.displayName,
      efforts: EFFORTS.filter((e) => (m.supportedEffortLevels ?? []).includes(e)),
    })),
    defaultModel,
    defaultEffort: userEffort(),
  };
}

warmSpare();
spare?.then(
  async (s) => {
    emit({ type: "ready" });
    try {
      models = pickerModels(await s.q.supportedModels());
      emitModels();
    } catch {}
  },
  () => {},
);
