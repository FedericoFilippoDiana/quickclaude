import { createSignal, createMemo, For, Show, onMount, onCleanup, createEffect, on, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { marked } from "marked";
import DOMPurify from "dompurify";
import "./App.css";

const WIDTH = 720;
const COMPACT_MAX = 560;
const CHAT_HEIGHT = 640;
// One width for every view, dragged from the panel's edges; the chat's height too. Both are kept.
const MIN_WIDTH = 480;
const MIN_TALL_HEIGHT = 320;
const SIZE_KEY = "quickclaude.size";
// Two spaces this close together on a new chat open your chats; one opens the last.
const DOUBLE_SPACE_MS = 350;
const MAX_IMAGE_EDGE = 2000; // px; larger pastes are scaled down before sending
const MAX_IMAGE_BYTES = 3_700_000; // keeps the base64 under the API's 5 MB image limit

type Image = { mediaType: string; data: string; url: string };

type Msg = {
  role: "user" | "assistant";
  text: string;
  images?: string[]; // data URLs of images pasted in this app
  imageCount?: number; // images in a reopened chat (not shown, only counted)
  status?: string;
  error?: string;
  meta?: string;
};

type Model = { value: string; name: string; efforts: string[] };
type SessionRow = { id: string; title: string; at: number; pinned: number }; // pinned: when, 0 = not

type AgentEvent =
  | { type: "ready" }
  | { type: "models"; models: Model[]; defaultModel: string; defaultEffort: string; chosen: boolean }
  | { type: "session"; id: string }
  | { type: "usage"; session: UsageWindow; weekly: UsageWindow }
  | { type: "delta"; turn: number; text: string }
  | { type: "tool"; turn: number; name: string }
  | {
      type: "done";
      turn: number;
      isError: boolean;
      error: string | null;
      result: string | null;
      durationMs: number;
    }
  | { type: "history"; sessions: SessionRow[] }
  | { type: "deleted"; id: string }
  | {
      type: "transcript";
      id: string;
      turn: number;
      messages: { role: "user" | "assistant"; text: string; images: number }[];
    }
  | { type: "handoff"; id: string }
  | { type: "compacted"; turn: number; before: number; after: number | null }
  | { type: "context"; turn: number; tokens: number }
  | { type: "tasks"; turn: number; count: number }
  | { type: "wake"; turn: number; compacting?: boolean }
  | { type: "activity"; ids: string[] }
  | { type: "notify" }
  | { type: "error"; turn?: number; message: string };

const send = (cmd: object) => invoke("agent_send", { line: JSON.stringify(cmd) });

// The context gauge shows from CONTEXT_WARN tokens, and turns red from CONTEXT_HIGH.
const CONTEXT_WARN = 100_000;
const CONTEXT_HIGH = 200_000;

const tokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Scale a pasted image down to a sensible size and return it base64-encoded.
async function prepareImage(blob: Blob): Promise<Image> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL("image/png");
  if (url.length * 0.75 > MAX_IMAGE_BYTES) url = canvas.toDataURL("image/jpeg", 0.85);
  const [head, data] = url.split(",");
  return { mediaType: head.slice(5, head.indexOf(";")), data, url };
}

function Markdown(props: { text: string }) {
  return (
    <div
      class="md"
      innerHTML={DOMPurify.sanitize(marked.parse(props.text, { async: false }) as string)}
    />
  );
}

function AssistantBody(props: { msg: Msg }) {
  return (
    <>
      <Show when={props.msg.text}>
        <Markdown text={props.msg.text} />
      </Show>
      <Show when={props.msg.status}>
        <div class="status">
          <span class="spinner" />
          {props.msg.status}
        </div>
      </Show>
      <Show when={props.msg.error}>
        <div class="error">{props.msg.error}</div>
      </Show>
    </>
  );
}

function UserBody(props: { msg: Msg }) {
  return (
    <div class="bubble">
      <Show when={props.msg.images?.length}>
        <div class="thumbs">
          <For each={props.msg.images}>{(url) => <img src={url} alt="" />}</For>
        </div>
      </Show>
      <Show when={props.msg.imageCount}>
        <div class="image-count">
          {props.msg.imageCount} image{props.msg.imageCount === 1 ? "" : "s"}
        </div>
      </Show>
      {props.msg.text}
    </div>
  );
}

type Overlay = "none" | "history" | "prefs" | "keys";
type Theme = "system" | "light" | "dark";
type Prefs = {
  bringForward: boolean;
  sound: boolean;
  notification: boolean;
  usageBar: boolean;
  theme: Theme; textSize: number };
type Toggle = Exclude<keyof Prefs, "theme" | "textSize">;
const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
// Text size, as a scale of the default: any step between these.
const TEXT_SIZE = { min: 0.7, max: 1.5, step: 0.05 };
const applyTextSize = (size: number) => document.documentElement.style.setProperty("--ts", String(size || 1));

// The settings in ⌘, (stored by the shell), in display order.
const PREF_ROWS: { key: Toggle; title: string; detail: string }[] = [
  {
    key: "bringForward",
    title: "Bring QuickClaude forward",
    detail: "When a chat finishes while you're away, open the panel with that chat.",
  },
  {
    key: "sound",
    title: "Play a sound",
    detail: "A short chime when a chat finishes while you're away.",
  },
  {
    key: "notification",
    title: "Show a notification",
    detail: "A macOS notification with the reply. Skipped when QuickClaude comes forward.",
  },
  {
    key: "usageBar",
    title: "Show the usage bar",
    detail: "A thin line along the bottom: how much of your 5-hour plan limit you've used.",
  },
];

// One plan rate-limit window from the sidecar: percent used and when it resets.
type UsageWindow = { used: number; resetsAt: string | null } | null;

// The shortcuts screen (⌘/), in the Preferences layout. The panel shows no key hints of its own.
const KEY_SECTIONS: { title: string; rows: { keys: string[]; title: string }[] }[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: ["⌥Space"], title: "Show QuickClaude: a new chat, or a reply you haven't seen" },
      { keys: ["⌘/"], title: "Keyboard shortcuts" },
      { keys: ["⌘,"], title: "Preferences" },
      { keys: ["⌘F"], title: "Full screen" },
      { keys: ["⌘T"], title: "Keep on top" },
      { keys: ["⌘N"], title: "New chat" },
      { keys: ["✦"], title: "Click the spark for your chats" },
      { keys: ["⌘⇧H"], title: "Continue in a terminal" },
      { keys: ["⌘."], title: "Stop the answer" },
      { keys: ["⇥"], title: "Next model" },
      { keys: ["⇧⇥"], title: "Next effort" },
      { keys: ["esc"], title: "Go back a step, then hide" },
      { keys: ["⇧esc"], title: "Hide, keeping everything as it is" },
    ],
  },
  {
    title: "Asking",
    rows: [
      { keys: ["↩"], title: "Ask, or continue the chat on screen" },
      { keys: ["⇧↩"], title: "New line" },
      { keys: ["↓"], title: "Open history (on an empty input)" },
      { keys: ["space"], title: "Open your last chat (on a new, empty chat)" },
      { keys: ["space", "space"], title: "Open all your chats (on a new, empty chat)" },
      { keys: ["⌘V"], title: "Paste an image" },
      { keys: ["⌫"], title: "Remove the last image (on an empty input)" },
      { keys: ["drop"], title: "Drop files to insert their paths" },
    ],
  },
  {
    title: "History",
    rows: [
      { keys: ["↑", "↓"], title: "Choose a chat" },
      { keys: ["↩"], title: "Open it" },
      { keys: ["⇧↑", "⇧↓"], title: "Select several (or ⇧click, ⌘click)" },
      { keys: ["⌘A"], title: "Select all" },
      { keys: ["⌘P"], title: "Pin or unpin (pinned chats stay on top)" },
      { keys: ["⌫"], title: "Delete (press twice)" },
      { keys: ["esc"], title: "Clear the selection, then close" },
    ],
  },
  {
    title: "Preferences",
    rows: [
      { keys: ["↑", "↓"], title: "Choose a setting" },
      { keys: ["space"], title: "Turn it on or off" },
      { keys: ["←", "→"], title: "Change the theme or text size" },
    ],
  },
];

export default function App() {
  const [messages, setMessages] = createStore<Msg[]>([]);
  const [mode, setMode] = createSignal<"compact" | "chat">("compact");
  const [overlay, setOverlay] = createSignal<Overlay>("none");
  const [busy, setBusy] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [attachments, setAttachments] = createSignal<Image[]>([]);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  // The open chat's name from history; a chat started here is named by its first question.
  const [chatTitle, setChatTitle] = createSignal("");
  const chatName = () => chatTitle() || messages.find((m) => m.role === "user")?.text || "Chat";
  const [models, setModels] = createSignal<Model[]>([]);
  const [model, setModel] = createSignal("");
  const [effort, setEffort] = createSignal("");
  // Which half of the label just changed; drives the highlight, dots and placeholder.
  const [flash, setFlash] = createSignal<"model" | "effort" | null>(null);
  const [sessions, setSessions] = createSignal<SessionRow[] | null>(null);
  const [selected, setSelected] = createSignal(0);
  // Background tasks of the open chat, and every chat with something running (history lamps).
  const [tasks, setTasks] = createSignal(0);
  const [active, setActive] = createSignal<Set<string>>(new Set());
  // The open chat's context size; unknown (null) until its first turn here.
  const [context, setContext] = createSignal<number | null>(null);
  // Plan usage for the bottom bar. `usageShown` restarts the fill animation on every show.
  const [usage, setUsage] = createSignal<{ session: UsageWindow; weekly: UsageWindow } | null>(null);
  const [usageShown, setUsageShown] = createSignal(false);
  // Busy, or waiting on background work that will reply by itself.
  const working = () => busy() || tasks() > 0;
  // Chats that finished while you were away and you haven't looked at yet, newest last.
  const [unseen, setUnseen] = createSignal<string[]>([]);
  const markSeen = (id: string | null) => id && setUnseen((u) => u.filter((x) => x !== id));
  let turn = 0;
  let stashedDraft = "";
  let input!: HTMLTextAreaElement;
  let panel!: HTMLDivElement;
  let logo!: SVGSVGElement;
  let list: HTMLDivElement | undefined;
  let historyList: HTMLDivElement | undefined;
  let keysList: HTMLDivElement | undefined;

  const win = getCurrentWindow();
  const last = () => messages.length - 1;
  const lastAnswer = () => messages[last()];
  // Preferences are tall too: their rows outgrew the compact panel's height cap and got cut off.
  const tall = () => overlay() === "history" || overlay() === "keys" || overlay() === "prefs" || (mode() === "chat" && overlay() === "none");

  // --- model & effort ---
  const modelName = () => models().find((m) => m.value === model())?.name ?? "";

  // The sidecar resolves the defaults: your last pick, else your Claude Code settings.
  function onModels(list: Model[], defaultModel: string, defaultEffort: string) {
    setModels(list);
    const m = list.find((x) => x.value === (model() || defaultModel)) ?? list[0];
    if (!m) return;
    setModel(m.value);
    const e = effort() || defaultEffort;
    setEffort(m.efforts.includes(e) ? e : (m.efforts[m.efforts.length - 1] ?? ""));
  }

  // Tab cycles the model, ⇧Tab the effort. The choice is saved by the sidecar.
  let flashTimer = 0;
  function cycle(kind: "model" | "effort") {
    const list = models();
    const i = list.findIndex((m) => m.value === model());
    if (i < 0) return;
    if (kind === "model") {
      const next = list[(i + 1) % list.length];
      setModel(next.value);
      if (!next.efforts.includes(effort())) setEffort(next.efforts[next.efforts.length - 1] ?? "");
    } else {
      const efforts = list[i].efforts;
      if (efforts.length < 2) return;
      setEffort(efforts[(efforts.indexOf(effort()) + 1) % efforts.length]);
    }
    send({ type: "choice", model: model(), effort: effort() });
    setFlash(kind);
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => setFlash(null), 1200);
  }

  // --- history ---
  // Pinned chats first (newest pin on top), then the rest by last activity.
  const ordered = createMemo(() =>
    [...(sessions() ?? [])].sort((a, b) => b.pinned - a.pinned || (a.pinned ? 0 : b.at - a.at)),
  );
  const filtered = createMemo(() => {
    const q = draft().trim().toLowerCase();
    const all = ordered();
    return q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  });
  // Chats picked with ⇧↑↓, ⇧click, ⌘click or ⌘A; empty means just the row under the cursor.
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  let anchor = 0; // where a ⇧ range starts
  const targets = () => {
    const p = picked();
    return p.size ? filtered().filter((r) => p.has(r.id)) : filtered().slice(selected(), selected() + 1);
  };
  const isTarget = (id: string) => (picked().size ? picked().has(id) : filtered()[selected()]?.id === id);
  // Deleting takes two presses: the first marks the rows, the second deletes them from Claude Code.
  const [armed, setArmed] = createSignal(false);
  // A new search starts at the top; a deletion keeps your place in the list.
  createEffect(
    on(draft, () => {
      if (overlay() !== "history") return;
      setSelected(0);
      setPicked(new Set<string>());
    }),
  );
  createEffect(() => {
    const n = filtered().length;
    if (selected() >= n) setSelected(Math.max(n - 1, 0));
  });
  createEffect(on([selected, picked, draft, overlay], () => setArmed(false)));

  function pickRange(to: number) {
    const [a, b] = [Math.min(anchor, to), Math.max(anchor, to)];
    setPicked(new Set(filtered().slice(a, b + 1).map((r) => r.id)));
  }

  function moveCursor(step: number, extend: boolean) {
    const n = filtered().length;
    if (!n) return;
    if (extend && !picked().size) anchor = selected();
    const to = extend ? Math.min(Math.max(selected() + step, 0), n - 1) : (selected() + step + n) % n;
    setSelected(to);
    if (extend) pickRange(to);
    else setPicked(new Set<string>());
  }

  function onRowClick(e: MouseEvent, i: number, row: SessionRow) {
    if (e.shiftKey) {
      if (!picked().size) anchor = selected();
      setSelected(i);
      pickRange(i);
    } else if (e.metaKey) {
      const p = new Set(picked().size ? picked() : [filtered()[selected()]?.id].filter(Boolean) as string[]);
      if (p.has(row.id)) p.delete(row.id);
      else p.add(row.id);
      setPicked(p);
      setSelected(i);
      anchor = i;
    } else openSession(row);
  }
  createEffect(() => {
    const i = selected();
    if (overlay() === "history") historyList?.children[i]?.scrollIntoView({ block: "nearest" });
  });

  // Rows that change place slide from where they were to where they land (FLIP).
  function flip(change: () => void, lift: Set<string>) {
    const rows = () => [...(historyList?.querySelectorAll<HTMLElement>("[data-id]") ?? [])];
    const before = new Map(rows().map((el) => [el.dataset.id!, el.getBoundingClientRect().top]));
    change();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const el of rows()) {
      const from = before.get(el.dataset.id!);
      const dy = from === undefined ? 0 : from - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      // The pinned rows pass over the others on their way up.
      if (lift.has(el.dataset.id!)) el.classList.add("lifted");
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(0.3, 0.7, 0.3, 1)",
      }).finished.then(
        () => el.classList.remove("lifted"),
        () => el.classList.remove("lifted"),
      );
    }
  }

  // ⌘P pins the chat under the cursor (or the selected ones); if all are pinned, it unpins them.
  // Their "when" column says "Pinned" or "Unpinned" for a moment.
  const [pinFlash, setPinFlash] = createSignal<{ ids: Set<string>; pinned: boolean } | null>(null);
  let pinTimer = 0;
  function togglePin() {
    const rows = targets();
    if (!rows.length) return;
    const pinned = rows.some((r) => !r.pinned);
    const ids = rows.map((r) => r.id);
    const now = Date.now();
    flip(() => {
      setSessions((all) =>
        all?.map((r) => (ids.includes(r.id) ? { ...r, pinned: pinned ? now - ids.indexOf(r.id) : 0 } : r)) ?? null,
      );
      // The cursor follows the chat it was on.
      setSelected(Math.max(filtered().findIndex((r) => r.id === ids[0]), 0));
    }, new Set(pinned ? ids : []));
    setPinFlash({ ids: new Set(ids), pinned });
    clearTimeout(pinTimer);
    pinTimer = window.setTimeout(() => setPinFlash(null), 1400);
    send({ type: "pin", ids, pinned });
  }

  function deleteSelected() {
    const rows = targets();
    if (!rows.length) return;
    if (!armed()) return setArmed(true);
    setArmed(false);
    setPicked(new Set<string>());
    // Land on the chat that follows the first deleted one.
    setSelected(filtered().indexOf(rows[0]));
    for (const row of rows) send({ type: "delete", id: row.id });
  }

  // --- preferences (⌘,) ---
  const [prefs, setPrefs] = createSignal<Prefs | null>(null);
  const [prefRow, setPrefRow] = createSignal(0);
  async function openPrefs() {
    setPrefRow(0);
    setOverlay("prefs");
    setPrefs(await invoke<Prefs>("get_prefs"));
  }
  function savePrefs(next: Prefs) {
    // Switching the usage bar back on fetches it now rather than at the next show.
    if (next.usageBar && !prefs()?.usageBar) send({ type: "usage" });
    setPrefs(next);
    applyTextSize(next.textSize);
    // The input's height was measured at the old size.
    queueMicrotask(autosize);
    invoke("set_prefs", { new: next }).catch((e) => setNotice(`Couldn't save preferences: ${e}`));
  }
  function togglePref(key: Toggle) {
    const p = prefs();
    if (!p) return;
    const next = { ...p, [key]: !p[key] };
    savePrefs(next);
    if (key === "sound" && next.sound) invoke("preview_sound");
  }
  // The theme row sits after the switches; step moves through System, Light, Dark.
  const themeRow = PREF_ROWS.length;
  function stepTheme(step: number) {
    const p = prefs();
    if (!p) return;
    const i = THEMES.findIndex((t) => t.value === p.theme);
    savePrefs({ ...p, theme: THEMES[(Math.max(i, 0) + step + THEMES.length) % THEMES.length].value });
  }
  // The text size row comes last; ←→ move it a step, ↩ puts it back to 100%.
  const sizeRow = themeRow + 1;
  function setTextSize(size: number) {
    const p = prefs();
    if (!p) return;
    const clamped = Math.min(Math.max(size, TEXT_SIZE.min), TEXT_SIZE.max);
    savePrefs({ ...p, textSize: Math.round(clamped / TEXT_SIZE.step) * TEXT_SIZE.step });
  }
  const stepSize = (step: number) => setTextSize((prefs()?.textSize || 1) + step * TEXT_SIZE.step);
  function onPrefsKey(e: KeyboardEvent) {
    const n = PREF_ROWS.length + 2;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setPrefRow((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (prefRow() === themeRow && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      stepTheme(e.key === "ArrowRight" ? 1 : -1);
    } else if (prefRow() === sizeRow && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      stepSize(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (prefRow() === themeRow) stepTheme(1);
      else if (prefRow() === sizeRow) setTextSize(1);
      else togglePref(PREF_ROWS[prefRow()].key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOverlay("none");
    }
  }

  function onKeysKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      keysList?.scrollBy({ top: e.key === "ArrowDown" ? 80 : -80, behavior: "smooth" });
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOverlay("none");
    }
  }

  function showHistory() {
    stashedDraft = draft();
    setDraft("");
    setSessions(null);
    setSelected(0);
    setOverlay("history");
    send({ type: "history" });
  }

  function closeOverlay() {
    if (overlay() === "history") {
      setDraft(stashedDraft);
      queueMicrotask(autosize);
    }
    setOverlay("none");
  }

  function openSession(row: SessionRow | undefined) {
    if (!row) return;
    turn++;
    setOverlay("none");
    setDraft("");
    setAttachments([]);
    setMessages([{ role: "assistant", text: "", status: "Opening chat…" }]);
    setBusy(false);
    setNotice("");
    setSessionId(row.id);
    markSeen(row.id);
    setChatTitle(row.title);
    setTasks(0);
    setContext(null);
    setMode("chat");
    send({ type: "open", id: row.id, turn });
  }

  // --- streaming: batch deltas into one store update per frame ---
  let pending = "";
  let frame = 0;
  const flush = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!pending || last() < 0) return;
    const chunk = pending;
    pending = "";
    setMessages(last(), (m) => ({ text: m.text + chunk, status: undefined }));
  };

  function onAgent(ev: AgentEvent) {
    if ("turn" in ev && ev.turn !== undefined && ev.turn !== turn) return;
    switch (ev.type) {
      case "models":
        onModels(ev.models, ev.defaultModel, ev.defaultEffort);
        break;
      case "session":
        setSessionId(ev.id);
        break;
      case "delta":
        pending += ev.text;
        if (!frame) frame = requestAnimationFrame(flush);
        break;
      case "tool":
        flush();
        setMessages(last(), "status", `Using ${ev.name.replace(/^mcp__[^_]+__/, "")}…`);
        break;
      case "done": {
        flush();
        const m = lastAnswer();
        setMessages(last(), {
          status: undefined,
          text: m.text || ev.result || "",
          error: ev.isError ? ev.error || "Something went wrong." : undefined,
          meta: `${(ev.durationMs / 1000).toFixed(1)}s`,
        });
        setBusy(false);
        break;
      }
      case "history":
        setSessions(ev.sessions);
        if (latestDue) onLatestList(ev.sessions);
        break;
      case "tasks":
        setTasks(ev.count);
        break;
      case "activity":
        setActive(new Set(ev.ids));
        break;
      case "wake": {
        // Claude carries on by itself (a background task finished), or a reopened chat is
        // mid-turn: continue its last answer. A /compact gets its own line, as when the chip started it.
        flush();
        const status = ev.compacting ? "Compacting…" : "Working…";
        if (lastAnswer()?.role === "assistant" && !ev.compacting) {
          if (lastAnswer().text) pending = "\n\n";
          setMessages(last(), { status, meta: undefined, error: undefined });
        } else setMessages(messages.length, { role: "assistant", text: "", status });
        setBusy(true);
        break;
      }
      case "deleted":
        setSessions((all) => all?.filter((s) => s.id !== ev.id) ?? null);
        markSeen(ev.id);
        // The open chat was the one deleted: it no longer exists to follow up on.
        if (sessionId() === ev.id) {
          turn++;
          setTasks(0);
          setMessages([]);
          setBusy(false);
          setMode("compact");
          setSessionId(null);
          setContext(null);
        }
        break;
      case "transcript":
        setMessages(
          ev.messages.map((m) => ({ role: m.role, text: m.text, imageCount: m.images || undefined })),
        );
        break;
      case "compacted":
        setMessages(
          last(),
          "text",
          ev.after === null
            ? `_Compacted from ${tokens(ev.before)} tokens._`
            : `_Compacted: ${tokens(ev.before)} → ${tokens(ev.after)} tokens._`,
        );
        break;
      case "context":
        setContext(ev.tokens);
        break;
      case "usage":
        setUsage({ session: ev.session, weekly: ev.weekly });
        requestAnimationFrame(() => setUsageShown(true));
        break;
      case "handoff":
        clear();
        win.hide();
        break;
      case "error":
        if (busy() && ev.turn !== undefined) {
          flush();
          setMessages(last(), { status: undefined, error: ev.message });
        } else {
          setNotice(ev.message);
        }
        setBusy(false);
        break;
    }
  }

  function ask(followUp: boolean) {
    const text = draft().trim();
    const images = attachments();
    if ((!text && !images.length) || (busy() && followUp)) return;
    turn++;
    pending = "";
    if (!followUp) {
      setMessages([]);
      setSessionId(null);
      setChatTitle("");
      setTasks(0);
      setContext(null);
    }
    setMessages(messages.length, { role: "user", text, images: images.map((i) => i.url) });
    setMessages(messages.length, { role: "assistant", text: "", status: "Thinking…" });
    setBusy(true);
    setNotice("");
    setDraft("");
    setAttachments([]);
    autosize();
    send({
      type: "ask",
      text,
      images: images.map(({ mediaType, data }) => ({ mediaType, data })),
      followUp,
      turn,
      model: model(),
      effort: effort(),
    });
  }

  function clear() {
    turn++;
    setTasks(0);
    setContext(null);
    setMessages([]);
    setBusy(false);
    setMode("compact");
    setOverlay("none");
    setDraft("");
    setAttachments([]);
    setSessionId(null);
    setChatTitle("");
    setNotice("");
  }

  function reset() {
    send({ type: "reset" });
    clear();
    input.focus();
  }

  // ⌘N: an empty input, and the panel glides back to the centre of its screen.
  function newChat() {
    reset();
    if (!full()) invoke("center_panel", { width: size.width });
  }

  // The spark shows your chats in place of the chat; again, it goes back.
  function toggleHistory() {
    if (overlay() === "history") closeOverlay();
    else showHistory();
  }

  // Space on a new, empty chat opens the one you used last, from a fresh list of your chats.
  let latestDue = false;
  let spaceAt = 0;
  function openLatest() {
    latestDue = true;
    send({ type: "history" });
  }
  function onLatestList(list: SessionRow[]) {
    latestDue = false;
    if (!fresh()) return;
    const latest = list.reduce<SessionRow | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
    if (latest) openSession(latest);
  }

  function toTerminal() {
    if (!sessionId() || working()) return;
    send({ type: "handoff" });
  }

  // /compact in the same session; the chat stays on screen with a note under it.
  function compact() {
    if (!sessionId() || working()) return;
    turn++;
    pending = "";
    setMode("chat");
    setMessages(messages.length, { role: "assistant", text: "", status: "Compacting…" });
    setBusy(true);
    setNotice("");
    send({ type: "compact", turn });
  }

  // The context chip compacts on a second click; the first asks "Compact 398k?".
  // Esc, typing, another chat or 5 s without the second click cancel it.
  const [compactArmed, setCompactArmed] = createSignal(false);
  let compactTimer = 0;
  function disarmCompact() {
    clearTimeout(compactTimer);
    setCompactArmed(false);
  }
  function onChipClick() {
    if (compactArmed()) {
      disarmCompact();
      compact();
    } else {
      setCompactArmed(true);
      compactTimer = window.setTimeout(() => setCompactArmed(false), 5000);
    }
  }
  createEffect(on([draft, sessionId], disarmCompact, { defer: true }));

  async function onPaste(e: ClipboardEvent) {
    const items = [...(e.clipboardData?.items ?? [])];
    const files = items.filter((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!files.length) return;
    if (!items.some((i) => i.type === "text/plain")) e.preventDefault();
    for (const item of files) {
      const blob = item.getAsFile();
      if (!blob) continue;
      try {
        const img = await prepareImage(blob);
        setAttachments((a) => [...a, img]);
      } catch {
        setNotice("Couldn't read that image.");
      }
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (overlay() !== "none") {
      const del = e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || !draft()));
      if (e.key === "Tab") e.preventDefault();
      else if (del) {
        e.preventDefault();
        deleteSelected();
      }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      } else if (e.metaKey && e.key === "a") {
        e.preventDefault();
        setPicked(new Set(filtered().map((r) => r.id)));
      } else if (e.metaKey && e.key === "p") {
        e.preventDefault();
        togglePin();
      } else if (e.key === "Enter") {
        e.preventDefault();
        openSession(filtered()[selected()]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // First drop a multi-selection, then leave the list.
        if (picked().size) setPicked(new Set<string>());
        else closeOverlay();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Asking opens the chat view, with your chats beside it; a new chat is ⌘N, or the shortcut.
      const followUp = messages.length > 0;
      setMode("chat");
      ask(followUp);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycle(e.shiftKey ? "effort" : "model");
    } else if (e.key === "ArrowDown" && !draft()) {
      e.preventDefault();
      showHistory();
    } else if (e.key === " " && !draft() && performance.now() - spaceAt < DOUBLE_SPACE_MS) {
      // A second space, quickly: all your chats instead of the last one, over the new chat
      // (the first space may already have opened the last one).
      e.preventDefault();
      spaceAt = 0;
      latestDue = false;
      if (mode() === "chat") reset();
      showHistory();
    } else if (e.key === " " && fresh()) {
      e.preventDefault();
      spaceAt = performance.now();
      openLatest();
    } else if (e.key === "Escape") {
      // One step back per press: cancel an asked compact, clear what's typed (and pasted),
      // close the chat, then hide.
      e.preventDefault();
      if (compactArmed()) disarmCompact();
      else if (draft() || attachments().length) {
        setDraft("");
        setAttachments([]);
        autosize();
      } else if (mode() === "chat") {
        // Back to an empty input. A chat that's still working keeps running in the background
        // (green lamp in history, notification when it replies).
        reset();
      } else win.hide();
    } else if (e.key === "Backspace" && !draft() && attachments().length) {
      e.preventDefault();
      setAttachments((a) => a.slice(0, -1));
    } else if (e.metaKey && e.key === "t") {
      e.preventDefault();
      toggleOnTop();
    } else if (e.metaKey && e.key === ".") {
      e.preventDefault();
      if (busy()) send({ type: "stop" });
    }
  }

  // Keep on top: the panel stays up when another app takes focus; Esc still hides it.
  // A faint accent ring marks it; toggling turns the spark a quarter and names the new state.
  const [onTop, setOnTop] = createSignal(false);
  const [onTopFlash, setOnTopFlash] = createSignal(false);
  let onTopTimer = 0;
  function toggleOnTop() {
    const next = !onTop();
    setOnTop(next);
    invoke("set_on_top", { on: next });
    logo.animate([{ transform: "rotate(0deg) scale(1)" }, { transform: "rotate(45deg) scale(1.18)" }, { transform: "rotate(90deg) scale(1)" }], {
      duration: 420,
      easing: "cubic-bezier(0.3, 0.7, 0.3, 1)",
    });
    setOnTopFlash(true);
    clearTimeout(onTopTimer);
    onTopTimer = window.setTimeout(() => setOnTopFlash(false), 1400);
  }

  // Full screen (⌘F, in any view): the panel fills the screen with a centred reading column.
  // The shell places it and puts it back; until then the panel stops sizing itself.
  const [full, setFull] = createSignal(false);
  async function toggleFull() {
    const next = !full();
    setFull(next);
    if (next) {
      await limitSize(undefined);
      invoke("set_full", { full: true, width: lastWidth, height: lastHeight });
    } else {
      // Measured with the full-screen layout gone, so the panel returns at its normal size.
      lastHeight = wantedHeight();
      lastWidth = size.width;
      await invoke("set_full", { full: false, width: lastWidth, height: lastHeight });
      limitSize(tall() ? null : lastHeight);
    }
  }

  // Nothing but an empty input: the shell reopens a fresh panel centred, wherever it was left.
  const fresh = createMemo(
    () => mode() === "compact" && messages.length === 0 && overlay() === "none" && !draft() && attachments().length === 0,
  );
  createEffect(() => invoke("set_fresh", { fresh: fresh() }));

  // Files dropped on the panel go into the input as their full paths, at the cursor.
  function insertPaths(paths: string[]) {
    if (!paths.length) return;
    const text = paths.join(" ");
    const start = input.selectionStart ?? draft().length;
    const end = input.selectionEnd ?? start;
    const before = draft().slice(0, start);
    const after = draft().slice(end);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const tail = after && !/^\s/.test(after) ? " " : "";
    setDraft(before + pad + text + tail + after);
    input.value = draft();
    const caret = (before + pad + text + tail).length;
    input.focus();
    input.setSelectionRange(caret, caret);
    autosize();
  }

  function autosize() {
    input.style.height = "auto";
    // Off screen (preferences, shortcuts) there's nothing to measure; it's redone on the way back.
    if (!input.isConnected) return;
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }

  // --- window sizing: compact hugs its content; chat and history are a fixed tall panel ---
  let lastHeight = 0;
  let lastWidth = 0;
  let wasTall = false;
  const size: { width: number; height: number } = (() => {
    try {
      return { width: WIDTH, height: CHAT_HEIGHT, ...JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}") };
    } catch {
      return { width: WIDTH, height: CHAT_HEIGHT };
    }
  })();
  const wantedHeight = () => (tall() ? size.height : Math.min(Math.ceil(panel.offsetHeight), COMPACT_MAX));
  // The width is always yours to drag. The bar's height follows its content (null: the chat's is free);
  // undefined lifts every limit, for full screen.
  const limitSize = (height: number | null | undefined) =>
    Promise.all([
      win.setMinSize(height === undefined ? null : new LogicalSize(MIN_WIDTH, height ?? MIN_TALL_HEIGHT)),
      win.setMaxSize(height == null ? null : new LogicalSize(100_000, height)),
    ]).catch(() => {});
  // Bumped by each resize, so a newer one takes over from an animation still running.
  let sizing = 0;
  let growing = false;
  const fit = async () => {
    if (full()) return;
    const h = wantedHeight();
    const w = size.width;
    if (h === lastHeight && w === lastWidth) return;
    // Never from less than the bar: a measure taken mid-change can be nearly empty.
    const from = Math.max(lastHeight, Math.min(h, 64));
    lastHeight = h;
    lastWidth = w;
    const isTall = tall();
    // Into the chat and back, the panel grows or shrinks downwards, easing out.
    const animate = isTall !== wasTall && from > 0;
    wasTall = isTall;
    const run = ++sizing;
    await limitSize(undefined);
    if (animate) {
      growing = true;
      await invoke("animate_size", { width: w, height: h }).catch(() => win.setSize(new LogicalSize(w, h)));
      if (run === sizing) growing = false;
    } else await win.setSize(new LogicalSize(w, h));
    if (run === sizing) limitSize(isTall ? null : h);
  };
  createEffect(() => win.setResizable(!full()).catch(() => {}));
  // A size you drag to (not one set here) is kept: its width for every view, its height for the chat.
  win.onResized(async ({ payload }) => {
    if (full() || growing) return;
    const now = payload.toLogical(await win.scaleFactor());
    const width = Math.round(now.width);
    const height = Math.round(now.height);
    if (Math.abs(width - lastWidth) < 2 && Math.abs(height - lastHeight) < 2) return;
    lastWidth = size.width = width;
    if (tall()) lastHeight = size.height = height;
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  });
  // The input bar moves between layouts when the view changes, so refocus it.
  createEffect(() => {
    mode();
    overlay();
    queueMicrotask(() => {
      autosize();
      fit();
      input.focus();
    });
  });

  // Keep the chat scrolled to the newest text while it streams.
  createEffect(() => {
    const m = messages[messages.length - 1];
    m?.text;
    m?.status;
    messages.length;
    overlay();
    if (mode() === "chat" && list) list.scrollTop = list.scrollHeight;
  });

  // ⇧Esc: hide and change nothing, so the panel reopens exactly as it was. Caught while
  // capturing, before the input's and history's own Esc steps can run.
  function onShiftEsc(e: KeyboardEvent) {
    if (!e.shiftKey || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    win.hide();
  }

  // Selecting text in the chat moves focus off the input; the panel's keys should still work.
  function onWindowKeyDown(e: KeyboardEvent) {
    // ⌘N works from every screen, history, preferences and shortcuts included.
    if (e.metaKey && e.key === "n") {
      e.preventDefault();
      newChat();
      return;
    }
    if (e.metaKey && e.code === "KeyF") {
      e.preventDefault();
      toggleFull();
      return;
    }
    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      if (overlay() === "prefs") setOverlay("none");
      else {
        if (overlay() === "history") closeOverlay();
        openPrefs();
      }
      return;
    }
    if (e.metaKey && e.key === "/") {
      e.preventDefault();
      if (overlay() === "keys") setOverlay("none");
      else {
        if (overlay() === "history") closeOverlay();
        setOverlay("keys");
      }
      return;
    }
    if (overlay() === "prefs") return onPrefsKey(e);
    if (overlay() === "keys") return onKeysKey(e);
    if (e.target === input) return;
    const panelKey = e.key === "Escape" || e.key === "Tab" || (e.metaKey && ["t", ".", "p"].includes(e.key));
    if (!panelKey) return;
    window.getSelection()?.removeAllRanges();
    input.focus();
    onKeyDown(e);
  }

  onMount(() => {
    invoke<Prefs>("get_prefs").then((p) => {
      setPrefs(p);
      applyTextSize(p.textSize);
      if (p.usageBar) send({ type: "usage" });
      autosize();
    });
    window.addEventListener("keydown", onShiftEsc, true);
    window.addEventListener("keydown", onWindowKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onShiftEsc, true);
      window.removeEventListener("keydown", onWindowKeyDown);
    });
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    const unlisten = Promise.all([
      listen<string>("agent", (e) => onAgent(JSON.parse(e.payload))),
      listen("open-prefs", () => openPrefs()),
      // ⌘⇧H arrives from the app menu (the shell), not as a key event.
      listen("to-terminal", () => overlay() === "none" && toTerminal()),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") insertPaths(e.payload.paths);
      }),
      listen<string>("open-chat", (e) => {
        if (sessionId() !== e.payload) openSession({ id: e.payload, title: "", at: 0, pinned: 0 });
        else setMode("chat");
      }),
      listen<string>("unseen", (e) => setUnseen((u) => [...u.filter((x) => x !== e.payload), e.payload])),
      listen("panel-shown", () => {
        // Refill the usage bar from empty, like a video's progress bar loading.
        setUsageShown(false);
        if (prefs()?.usageBar !== false) send({ type: "usage" });
        // A new chat, unless something is waiting for you: a reply you haven't seen (the open
        // chat's first), a chat still working, or text you haven't sent. Then it's as you left it.
        const waiting = unseen().includes(sessionId() ?? "") || working() || draft() || attachments().length;
        if (!waiting) {
          const next = unseen()[unseen().length - 1];
          if (next) openSession({ id: next, title: "", at: 0, pinned: 0 });
          else if (!fresh()) newChat();
        }
        markSeen(sessionId());
        if (overlay() === "history") {
          // A delete armed before hiding shouldn't fire on the first key after; the list may be stale.
          setArmed(false);
          send({ type: "history" });
        }
        input.focus();
      }),
    ]);
    onCleanup(() => {
      observer.disconnect();
      unlisten.then((fns) => fns.forEach((u) => u()));
    });
    send({ type: "hello" });
    input.focus();
  });

  // Drag the panel by any spot that isn't a control or selectable text; it reopens where it's left.
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0 || full()) return;
    if ((e.target as HTMLElement).closest("button, a, textarea, input, .pref, .answer, .list, .logo")) return;
    e.preventDefault();
    win.startDragging();
  }

  // Open links in the default browser instead of inside the panel.
  function onClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (a?.href) {
      e.preventDefault();
      openUrl(a.href);
    }
  }

  const bar = (
    <div class="bar-wrap">
      <Show when={attachments().length && overlay() !== "history"}>
        <div class="attachments">
          <For each={attachments()}>
            {(img, i) => (
              <button
                class="attachment"
                title="Remove"
                onClick={() => setAttachments((a) => a.filter((_, j) => j !== i()))}
              >
                <img src={img.url} alt="" />
                <span>×</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="bar">
        <svg ref={logo} class="logo" viewBox="2 0 20 20" aria-label="Your chats" role="button" onClick={toggleHistory}>
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
        </svg>
        <textarea
          ref={input}
          rows={1}
          value={draft()}
          placeholder={
            overlay() === "history"
              ? "Search chats…"
              : onTopFlash()
              ? onTop()
                ? "Keep on top: on"
                : "Keep on top: off"
              : flash()
                ? `Ask ${modelName()} · ${effort()}…`
                : mode() === "chat" || messages.length
                  ? "Ask a follow-up…"
                  : "Ask Claude…"
          }
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellcheck={false}
        />
        <Show when={busy()}>
          <button class="stop" title="Stop (⌘.)" onClick={() => send({ type: "stop" })}>
            ■
          </button>
        </Show>
        <Show when={modelName() && overlay() !== "history"}>
          <div class="model-label">
            <button class="part model" title="Next model (⇥)" onClick={() => cycle("model")}>
              <Show when={model()} keyed>
                {(_) => <span classList={{ flash: flash() === "model" }}>{modelName()}</span>}
              </Show>
              <Show when={flash() === "model"}>
                <span class="dots">
                  <For each={models()}>{(m) => <i classList={{ on: m.value === model() }} />}</For>
                </span>
              </Show>
            </button>
            <span class="sep">·</span>
            <button class="part" title="Next effort (⇧⇥)" onClick={() => cycle("effort")}>
              <Show when={effort()} keyed>
                {(e) => <span classList={{ flash: flash() === "effort" }}>{e}</span>}
              </Show>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );

  // Claude ended its turn but left work running; it will reply by itself when that finishes.
  const waiting = () => (
    <Show when={!busy() && tasks() > 0}>
      <div class="status">
        <span class="lamp" />
        <span>
          {tasks() === 1
            ? "Waiting on a background task; Claude will reply when it finishes."
            : `Waiting on ${tasks()} background tasks; Claude will reply when they finish.`}
        </span>
      </div>
    </Show>
  );

  const footer = (hints: string[]): JSX.Element => (
    <div class="footer">
      <For each={hints}>{(h) => <span class="hint">{h}</span>}</For>
    </div>
  );

  const prefsView = (
    <>
      <div class="prefs-head">Preferences</div>
      <div class="prefs">
        <For each={PREF_ROWS}>
          {(row, i) => (
            <button
              class="pref"
              classList={{ selected: i() === prefRow() }}
              onMouseMove={() => setPrefRow(i())}
              onClick={() => togglePref(row.key)}
            >
              <span class="pref-text">
                <span class="pref-title">{row.title}</span>
                <span class="pref-detail">{row.detail}</span>
              </span>
              <span class="switch" classList={{ on: !!prefs()?.[row.key] }} role="switch" aria-checked={!!prefs()?.[row.key]}>
                <span class="knob" />
              </span>
            </button>
          )}
        </For>
        <div
          class="pref"
          classList={{ selected: prefRow() === themeRow }}
          onMouseMove={() => setPrefRow(themeRow)}
        >
          <span class="pref-text">
            <span class="pref-title">Theme</span>
            <span class="pref-detail">System follows your Mac's light or dark appearance.</span>
          </span>
          <span class="segments" role="radiogroup">
            <For each={THEMES}>
              {(t) => (
                <span
                  role="radio"
                  aria-checked={prefs()?.theme === t.value}
                  classList={{ on: prefs()?.theme === t.value }}
                  onClick={() => {
                    const p = prefs();
                    if (p) savePrefs({ ...p, theme: t.value });
                  }}
                >
                  {t.label}
                </span>
              )}
            </For>
          </span>
        </div>
        <div
          class="pref"
          classList={{ selected: prefRow() === sizeRow }}
          onMouseMove={() => setPrefRow(sizeRow)}
        >
          <span class="pref-text">
            <span class="pref-title">Text size</span>
            <span class="pref-detail">The size of all text in the panel.</span>
          </span>
          <span class="size">
            <input
              type="range"
              min={TEXT_SIZE.min}
              max={TEXT_SIZE.max}
              step={TEXT_SIZE.step}
              value={prefs()?.textSize || 1}
              aria-label="Text size"
              onInput={(e) => setTextSize(Number(e.currentTarget.value))}
            />
            <span class="size-value">{Math.round((prefs()?.textSize || 1) * 100)}%</span>
          </span>
        </div>
      </div>
      <div class="prefs-foot">
        <span>Chats live in ~/QuickClaude</span>
        <span class="hint">⌘/ shortcuts</span>
      </div>
    </>
  );

  const keysView = (
    <>
      <div class="prefs-head">Keyboard Shortcuts</div>
      <div class="keys" ref={keysList}>
        <For each={KEY_SECTIONS}>
          {(section) => (
            <>
              <div class="keys-section">{section.title}</div>
              <div class="prefs">
                <For each={section.rows}>
                  {(row) => (
                    <div class="pref">
                      <span class="pref-text">
                        <span class="pref-title">{row.title}</span>
                      </span>
                      <span class="caps">
                        <For each={row.keys}>{(k) => <span>{k}</span>}</For>
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </For>
      </div>
      <div class="prefs-foot">
        <span>esc close</span>
      </div>
    </>
  );

  const historyView = (
    <>
      {bar}
      <div class="history" ref={historyList}>
        <Show when={sessions()} fallback={<div class="status pad">Loading chats…</div>}>
          <For each={filtered()} fallback={<div class="status pad">No matching chats.</div>}>
            {(row, i) => (
              <button
                class="row"
                data-id={row.id}
                classList={{
                  selected: i() === selected(),
                  picked: picked().has(row.id),
                  armed: armed() && isTarget(row.id),
                }}
                onMouseMove={() => !picked().size && setSelected(i())}
                onClick={(e) => onRowClick(e, i(), row)}
              >
                <Show when={active().has(row.id)}>
                  <span class="lamp" title="Working" />
                </Show>
                <Show when={row.pinned}>
                  <svg class="pin" viewBox="0 0 16 16" aria-label="Pinned">
                    <path d="M10.5 1.5l4 4-2 1-2.5 2.5.5 3.5-1.5 1.5-3-3L2 15l-.5-.5 4-4-3-3L4 6l3.5.5L10 4z" />
                  </svg>
                </Show>
                <span class="title">{row.title}</span>
                <span class="when" classList={{ flash: !!pinFlash()?.ids.has(row.id) && !(armed() && isTarget(row.id)) }}>
                  {!(armed() && isTarget(row.id))
                    ? pinFlash()?.ids.has(row.id)
                      ? pinFlash()!.pinned
                        ? "Pinned"
                        : "Unpinned"
                      : ago(row.at)
                    : targets()[0]?.id !== row.id
                      ? "delete"
                      : targets().length > 1
                        ? `press ⌫ again to delete ${targets().length} chats`
                        : "press ⌫ again to delete"}
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
      <Show when={picked().size > 1}>{footer([`${picked().size} selected`])}</Show>
    </>
  );

  return (
    <div
      ref={panel}
      class="panel"
      classList={{ tall: tall(), full: full(), chat: mode() === "chat" && overlay() === "none" }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      <div class="top-ring" classList={{ on: onTop() }} />
      <UsageBar usage={usage()} on={prefs()?.usageBar !== false} shown={usageShown()} />
      <Show when={overlay() !== "keys"} fallback={keysView}>
      <Show when={overlay() !== "prefs"} fallback={prefsView}>
      <Show when={overlay() !== "history"} fallback={historyView}>
        <Show
          when={mode() === "chat"}
          fallback={
            <>
              {bar}
              <>
                <Show when={lastAnswer()?.role === "assistant"}>
                  <div class="answer">
                    <div class="question">
                      {messages[last() - 1]?.images?.length ? "🖼 " : ""}
                      {messages[last() - 1]?.text}
                    </div>
                    <AssistantBody msg={lastAnswer()} />
                    {waiting()}
                  </div>
                </Show>
                <Show when={messages.length || notice()}>
                  <div class="footer">
                    <span class="notice">{notice()}</span>
                    <Show when={!busy() && messages.length}>
                      <span class="meta">{lastAnswer()?.meta}</span>
                    </Show>
                  </div>
                </Show>
              </>
            </>
          }
        >
          <div class="chat-head">
            <span class="chat-name">{chatName()}</span>
            <Show when={(context() ?? 0) >= CONTEXT_WARN}>
              <button
                class="context"
                classList={{ high: context()! >= CONTEXT_HIGH, armed: compactArmed() }}
                title={compactArmed() ? "Click again to compact this chat. Esc cancels." : "Context size of this chat. Click to compact it."}
                onClick={onChipClick}
              >
                <span class="grow">
                  <span>Compact&nbsp;</span>
                </span>
                {tokens(context()!)}
                <span class="grow">
                  <span>?</span>
                </span>
              </button>
            </Show>
          </div>
          <div class="list" ref={list}>
            <For each={messages}>
              {(m) => (
                <div class={`msg ${m.role}`}>
                  <Show when={m.role === "assistant"} fallback={<UserBody msg={m} />}>
                    <AssistantBody msg={m} />
                  </Show>
                </div>
              )}
            </For>
            {waiting()}
            <Show when={notice()}>
              <div class="error">{notice()}</div>
            </Show>
          </div>
          {bar}
        </Show>
      </Show>
      </Show>
      </Show>
    </div>
  );
}

const pct = (n: number) => `${Math.round(n)}%`;
const resetIn = (iso: string | null) => {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return mins >= 60 ? ` · resets in ${Math.floor(mins / 60)}h ${mins % 60}m` : ` · resets in ${mins}m`;
};

// A hairline along the bottom edge: the share of the 5-hour plan limit used; full means none left.
// Hover it for the numbers, weekly limit included.
function UsageBar(props: {
  usage: { session: UsageWindow; weekly: UsageWindow } | null;
  on: boolean;
  shown: boolean;
}) {
  const used = () => (props.usage?.session ? Math.min(100, Math.max(0, props.usage.session.used)) : null);
  const title = () => {
    const u = props.usage;
    if (!u) return "";
    const parts = [];
    if (u.session) parts.push(`5-hour limit: ${pct(u.session.used)} used${resetIn(u.session.resetsAt)}`);
    if (u.weekly) parts.push(`Weekly limit: ${pct(u.weekly.used)} used${resetIn(u.weekly.resetsAt)}`);
    return parts.join("\n");
  };
  return (
    <Show when={props.on && used() !== null}>
      <div class="usage-clip">
        <div class="usage-bar" title={title()}>
          <div
            class="usage-fill"
            classList={{ low: used()! > 80, out: used()! > 95 }}
            style={{ transform: `scaleX(${props.shown ? used()! / 100 : 0})` }}
          />
        </div>
      </div>
    </Show>
  );
}
