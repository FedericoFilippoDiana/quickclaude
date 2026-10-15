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
type SessionRow = { id: string; title: string; at: number };

type AgentEvent =
  | { type: "ready" }
  | { type: "models"; models: Model[]; defaultModel: string; defaultEffort: string; chosen: boolean }
  | { type: "session"; id: string }
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
  | { type: "tasks"; turn: number; count: number }
  | { type: "wake"; turn: number }
  | { type: "activity"; ids: string[] }
  | { type: "notify" }
  | { type: "error"; turn?: number; message: string };

const send = (cmd: object) => invoke("agent_send", { line: JSON.stringify(cmd) });

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

type Overlay = "none" | "history" | "prefs";
type Theme = "system" | "light" | "dark";
type Prefs = { bringForward: boolean; sound: boolean; notification: boolean; theme: Theme };
type Toggle = Exclude<keyof Prefs, "theme">;
const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

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
  const [models, setModels] = createSignal<Model[]>([]);
  const [model, setModel] = createSignal("");
  const [effort, setEffort] = createSignal("");
  // Which half of the label just changed; drives the highlight, dots and placeholder.
  const [flash, setFlash] = createSignal<"model" | "effort" | null>(null);
  const [chosen, setChosen] = createSignal(true);
  const [sessions, setSessions] = createSignal<SessionRow[] | null>(null);
  const [selected, setSelected] = createSignal(0);
  // Background tasks of the open chat, and every chat with something running (history lamps).
  const [tasks, setTasks] = createSignal(0);
  const [active, setActive] = createSignal<Set<string>>(new Set());
  // Busy, or waiting on background work that will reply by itself.
  const working = () => busy() || tasks() > 0;
  let turn = 0;
  let stashedDraft = "";
  let input!: HTMLTextAreaElement;
  let panel!: HTMLDivElement;
  let list: HTMLDivElement | undefined;
  let historyList: HTMLDivElement | undefined;

  const win = getCurrentWindow();
  const last = () => messages.length - 1;
  const lastAnswer = () => messages[last()];
  const tall = () => overlay() === "history" || (mode() === "chat" && overlay() !== "prefs");

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
    setChosen(true);
    setFlash(kind);
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => setFlash(null), 1200);
  }

  // --- history ---
  const filtered = createMemo(() => {
    const q = draft().trim().toLowerCase();
    const all = sessions() ?? [];
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
    setPrefs(next);
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
  function onPrefsKey(e: KeyboardEvent) {
    const n = PREF_ROWS.length + 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setPrefRow((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (prefRow() === themeRow && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      stepTheme(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (prefRow() === themeRow) stepTheme(1);
      else togglePref(PREF_ROWS[prefRow()].key);
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
    setTasks(0);
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
        setChosen(ev.chosen);
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
        break;
      case "tasks":
        setTasks(ev.count);
        break;
      case "activity":
        setActive(new Set(ev.ids));
        break;
      case "wake":
        // Claude carries on by itself (a background task finished): continue its last answer.
        flush();
        if (lastAnswer()?.role === "assistant") {
          if (lastAnswer().text) pending = "\n\n";
          setMessages(last(), { status: "Working…", meta: undefined, error: undefined });
        } else setMessages(messages.length, { role: "assistant", text: "", status: "Working…" });
        setBusy(true);
        break;
      case "deleted":
        setSessions((all) => all?.filter((s) => s.id !== ev.id) ?? null);
        // The open chat was the one deleted: it no longer exists to follow up on.
        if (sessionId() === ev.id) {
          turn++;
          setTasks(0);
          setMessages([]);
          setBusy(false);
          setMode("compact");
          setSessionId(null);
        }
        break;
      case "transcript":
        setMessages(
          ev.messages.map((m) => ({ role: m.role, text: m.text, imageCount: m.images || undefined })),
        );
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
      setTasks(0);
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
    setMessages([]);
    setBusy(false);
    setMode("compact");
    setOverlay("none");
    setDraft("");
    setAttachments([]);
    setSessionId(null);
    setNotice("");
  }

  function reset() {
    send({ type: "reset" });
    clear();
    input.focus();
  }

  function toTerminal() {
    if (!sessionId() || working()) return;
    send({ type: "handoff" });
  }

  function expand() {
    if (messages.length) setMode("chat");
  }

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
      if (mode() === "chat") ask(true);
      else if (e.metaKey && messages.length) {
        setMode("chat");
        ask(true);
      } else ask(false);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycle(e.shiftKey ? "effort" : "model");
    } else if (e.key === "ArrowDown" && !draft()) {
      e.preventDefault();
      showHistory();
    } else if (e.key === "Escape") {
      // One step back per press: clear what's typed (and pasted), close the chat, then hide.
      e.preventDefault();
      if (draft() || attachments().length) {
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
    } else if (e.metaKey && e.key === "n") {
      e.preventDefault();
      reset();
    } else if (e.metaKey && e.key === "p") {
      e.preventDefault();
      togglePin();
    } else if (e.metaKey && e.key === "t") {
      e.preventDefault();
      toTerminal();
    } else if (e.metaKey && e.key === ".") {
      e.preventDefault();
      if (busy()) send({ type: "stop" });
    }
  }

  // Pinned, the panel stays up (and on top) when another app takes focus; Esc still hides it.
  const [pinned, setPinned] = createSignal(false);
  function togglePin() {
    const next = !pinned();
    setPinned(next);
    invoke("set_pinned", { pinned: next });
  }

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
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  }

  // --- window sizing: compact hugs its content; chat and history are a fixed tall panel ---
  let lastHeight = 0;
  const fit = () => {
    const h = tall() ? CHAT_HEIGHT : Math.min(Math.ceil(panel.offsetHeight), COMPACT_MAX);
    if (h !== lastHeight) {
      lastHeight = h;
      win.setSize(new LogicalSize(WIDTH, h));
    }
  };
  // The input bar moves between layouts when the view changes, so refocus it.
  createEffect(() => {
    mode();
    overlay();
    queueMicrotask(() => {
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

  // Selecting text in the chat moves focus off the input; the panel's keys should still work.
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      if (overlay() === "prefs") setOverlay("none");
      else {
        if (overlay() === "history") closeOverlay();
        openPrefs();
      }
      return;
    }
    if (overlay() === "prefs") return onPrefsKey(e);
    if (e.target === input) return;
    const panelKey = e.key === "Escape" || e.key === "Tab" || (e.metaKey && ["t", "n", ".", "p"].includes(e.key));
    if (!panelKey) return;
    window.getSelection()?.removeAllRanges();
    input.focus();
    onKeyDown(e);
  }

  onMount(() => {
    window.addEventListener("keydown", onWindowKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown));
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    const unlisten = Promise.all([
      listen<string>("agent", (e) => onAgent(JSON.parse(e.payload))),
      listen("open-prefs", () => openPrefs()),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") insertPaths(e.payload.paths);
      }),
      listen<string>("open-chat", (e) => {
        if (sessionId() !== e.payload) openSession({ id: e.payload, title: "", at: 0 });
        else setMode("chat");
      }),
      listen("panel-shown", () => {
        if (overlay() !== "none") closeOverlay();
        // Like Spotlight, a finished one-off answer doesn't come back; running answers and chats do.
        if (mode() === "compact" && !working() && messages.length) reset();
        input.focus();
        input.select();
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
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, textarea, input, .pref, .answer, .list")) return;
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
        <svg class="logo" viewBox="2 0 20 20" aria-hidden="true">
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
        </svg>
        <textarea
          ref={input}
          rows={1}
          value={draft()}
          placeholder={
            overlay() === "history"
              ? "Search chats…"
              : flash()
                ? `Ask ${modelName()} · ${effort()}…`
                : mode() === "chat"
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
            <Show when={!chosen()}>
              <span class="first-hint">⇥ model · ⇧⇥ effort</span>
            </Show>
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
      </div>
      <div class="prefs-foot">
        <span>⌥Space opens QuickClaude · chats live in ~/QuickClaude</span>
        <span class="hint">↑↓ choose</span>
        <span class="hint">space toggle · ←→ theme</span>
        <span class="hint">esc close</span>
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
                <span class="title">{row.title}</span>
                <span class="when">
                  {!(armed() && isTarget(row.id))
                    ? ago(row.at)
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
      {footer(
        picked().size > 1
          ? [`${picked().size} selected`, "⌫ delete", "esc back"]
          : ["↑↓ choose", "⇧ select more", "↩ open", "⌫ delete", "esc back"],
      )}
    </>
  );

  return (
    <div
      ref={panel}
      class="panel"
      classList={{ tall: tall(), chat: mode() === "chat" && overlay() === "none" }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
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
                      <span class="hint">↩ new question</span>
                      <button class="hint link" onClick={expand}>
                        ⌘↩ follow up
                      </button>
                      <Show when={sessionId() && !working()}>
                        <button class="hint link" onClick={toTerminal}>
                          ⌘T terminal
                        </button>
                      </Show>
                      <span class="meta">{lastAnswer()?.meta}</span>
                    </Show>
                  </div>
                </Show>
              </>
            </>
          }
        >
          <div class="chat-head">
            <span>Chat</span>
            <span class="actions">
              <Show when={sessionId() && !working()}>
                <button class="hint link" onClick={toTerminal}>
                  ⌘T terminal
                </button>
              </Show>
              <button class="hint link" onClick={reset}>
                ⌘N new
              </button>
            </span>
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
    </div>
  );
}
