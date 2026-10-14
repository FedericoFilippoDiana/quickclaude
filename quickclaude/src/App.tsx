import { createSignal, createMemo, For, Show, onMount, onCleanup, createEffect, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
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
  | {
      type: "transcript";
      id: string;
      turn: number;
      messages: { role: "user" | "assistant"; text: string; images: number }[];
    }
  | { type: "handoff"; id: string }
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

type Overlay = "none" | "history";

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
  let turn = 0;
  let stashedDraft = "";
  let input!: HTMLTextAreaElement;
  let panel!: HTMLDivElement;
  let list: HTMLDivElement | undefined;
  let historyList: HTMLDivElement | undefined;

  const win = getCurrentWindow();
  const last = () => messages.length - 1;
  const lastAnswer = () => messages[last()];
  const tall = () => overlay() === "history" || mode() === "chat";

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
  createEffect(() => {
    filtered();
    if (overlay() === "history") setSelected(0);
  });
  createEffect(() => {
    const i = selected();
    if (overlay() === "history") historyList?.children[i]?.scrollIntoView({ block: "nearest" });
  });

  function showHistory() {
    stashedDraft = draft();
    setDraft("");
    setSessions(null);
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
    if (!sessionId() || busy()) return;
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
      const n = filtered().length;
      if (e.key === "Tab") e.preventDefault();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      } else if (e.key === "Enter") {
        e.preventDefault();
        openSession(filtered()[selected()]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeOverlay();
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
      // One step back per press: clear what's typed (and pasted), then collapse and hide.
      e.preventDefault();
      if (draft() || attachments().length) {
        setDraft("");
        setAttachments([]);
        autosize();
      } else {
        if (mode() === "chat") setMode("compact");
        win.hide();
      }
    } else if (e.key === "Backspace" && !draft() && attachments().length) {
      e.preventDefault();
      setAttachments((a) => a.slice(0, -1));
    } else if (e.metaKey && e.key === "n") {
      e.preventDefault();
      reset();
    } else if (e.metaKey && e.key === "t") {
      e.preventDefault();
      toTerminal();
    } else if (e.metaKey && e.key === ".") {
      e.preventDefault();
      if (busy()) send({ type: "stop" });
    }
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
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

  onMount(() => {
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    const unlisten = Promise.all([
      listen<string>("agent", (e) => onAgent(JSON.parse(e.payload))),
      listen("panel-shown", () => {
        if (overlay() !== "none") closeOverlay();
        // Like Spotlight, a finished one-off answer doesn't come back; running answers and chats do.
        if (mode() === "compact" && !busy() && messages.length) reset();
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
        <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
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

  const footer = (hints: string[]): JSX.Element => (
    <div class="footer">
      <For each={hints}>{(h) => <span class="hint">{h}</span>}</For>
    </div>
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
                classList={{ selected: i() === selected() }}
                onMouseMove={() => setSelected(i())}
                onClick={() => openSession(row)}
              >
                <span class="title">{row.title}</span>
                <span class="when">{ago(row.at)}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
      {footer(["↑↓ choose", "↩ open", "esc back"])}
    </>
  );

  return (
    <div
      ref={panel}
      class="panel"
      classList={{ tall: tall(), chat: mode() === "chat" && overlay() !== "history" }}
      onClick={onClick}
    >
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
                      <Show when={sessionId()}>
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
              <Show when={sessionId() && !busy()}>
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
            <Show when={notice()}>
              <div class="error">{notice()}</div>
            </Show>
          </div>
          {bar}
        </Show>
      </Show>
    </div>
  );
}
