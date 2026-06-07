"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "chief_of_staff" | "system";
  content: string;
  image?: string | null;
};

// Downscale an image client-side so uploads + storage stay small.
async function fileToResizedDataUrl(file: File, max = 1024, quality = 0.8): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

type Glance = {
  opener: string;
  note: string | null;
  tasksDue: number;
  events: string[];
  focusRoleName: string | null;
};

const SUGGESTIONS = [
  "What's on tap today?",
  "I'm overwhelmed.",
  "What can I ignore today?",
  "Why this?",
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function ScoutGlance({ glance }: { glance: Glance }) {
  const hasToday = glance.tasksDue > 0 || glance.events.length > 0;
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-4 space-y-3">
      <div>
        <div className="text-sm text-neutral-500">{greeting()}, Selena.</div>
        <div className="prose-chat text-[17px] leading-relaxed text-neutral-900 mt-1">
          {glance.opener}
        </div>
      </div>

      {hasToday && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 mb-1">
            Today
          </div>
          <ul className="space-y-0.5 text-[15px] text-neutral-700">
            {glance.tasksDue > 0 && (
              <li>· {glance.tasksDue} task{glance.tasksDue !== 1 ? "s" : ""} due</li>
            )}
            {glance.events.map((e, i) => (
              <li key={i}>· {e}</li>
            ))}
          </ul>
        </div>
      )}

      {glance.note && (
        <div className="rounded-xl bg-neutral-50 px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 mb-0.5">
            Scout noticed
          </div>
          <div className="text-[15px] text-neutral-700">{glance.note}</div>
        </div>
      )}
    </div>
  );
}

export default function ChatClient({
  initialConversationId,
  initialMessages,
  glance,
}: {
  initialConversationId: string | null;
  initialMessages: Msg[];
  glance: Glance | null;
}) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [waiting, setWaiting] = useState(false); // a reply may be generating from a prior turn
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function attachFile(file: File | null | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setImage(await fileToResizedDataUrl(file));
    } catch {
      setError("Couldn't read that image.");
    }
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    await attachFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    attachFile([...e.dataTransfer.files].find((f) => f.type.startsWith("image/")));
  }

  function onPaste(e: React.ClipboardEvent) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (item) {
      e.preventDefault();
      attachFile(item.getAsFile());
    }
  }

  const landed = useRef(false);

  useEffect(() => {
    // Open at the most recent message: jump instantly on first load, smooth after.
    bottomRef.current?.scrollIntoView({ behavior: landed.current ? "smooth" : "auto" });
    landed.current = true;
  }, [messages, sending, waiting]);

  // Resilient replies: if we land here and the last message is ours with no reply,
  // Scout may still be working server-side (e.g. you popped into Compass). Poll
  // until the reply lands instead of losing it.
  useEffect(() => {
    const last = initialMessages[initialMessages.length - 1];
    if (!last || last.role !== "user") return;
    let active = true;
    let tries = 0;
    setWaiting(true);
    const iv = setInterval(async () => {
      tries++;
      try {
        const res = await fetch("/api/chat");
        const data = await res.json();
        const msgs: { id: string; role: Msg["role"]; content: string; metadataJson?: { image?: string } | null }[] =
          data.messages ?? [];
        const lastFetched = msgs[msgs.length - 1];
        if (active && lastFetched?.role === "chief_of_staff" && msgs.length >= initialMessages.length) {
          setMessages(msgs.map((x) => ({ id: x.id, role: x.role, content: x.content, image: x.metadataJson?.image ?? null })));
          setWaiting(false);
          clearInterval(iv);
        }
      } catch {
        /* keep polling */
      }
      if (tries >= 20 && active) {
        setWaiting(false);
        clearInterval(iv);
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(iv);
    };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(text: string) {
    const content = text.trim();
    const img = image;
    if ((!content && !img) || sending) return;
    setError(null);
    setSending(true);

    // Optimistic user bubble (shows the image immediately).
    const tempId = `temp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content: content || "📷 Photo", image: img }]);
    setInput("");
    setImage(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content, image: img }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      const data = await res.json();
      setConversationId(data.conversationId);
      // Replace optimistic message with the real pair (carry image from metadata).
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        ...data.messages.map((x: { id: string; role: Msg["role"]; content: string; metadataJson?: { image?: string } | null }) => ({
          id: x.id,
          role: x.role,
          content: x.content,
          image: x.metadataJson?.image ?? null,
        })),
      ]);
    } catch (e: unknown) {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setInput(content);
      setImage(img);
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="relative flex flex-col h-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 m-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-400 bg-white/80 text-sm font-medium text-neutral-600">
          Drop image to attach
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-2xl space-y-4">
          {glance && <ScoutGlance glance={glance} />}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`prose-chat max-w-[85%] rounded-2xl px-4 py-2.5 text-[17px] leading-relaxed ${
                  m.role === "user"
                    ? "bg-neutral-900 text-white rounded-br-sm"
                    : "bg-white border border-neutral-200 text-neutral-900 rounded-bl-sm"
                }`}
              >
                {m.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.image}
                    alt="attachment"
                    className="mb-1.5 max-h-64 w-auto rounded-lg"
                  />
                )}
                {m.content && renderContent(m.content)}
              </div>
            </div>
          ))}
          {(sending || waiting) && (
            <div className="flex justify-start">
              <div className="bg-white border border-neutral-200 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-neutral-400">
                {waiting && !sending ? "Scout's still on it…" : "thinking…"}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div
        className="border-t border-neutral-200 bg-white px-4 pt-3"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto max-w-2xl">
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-xs rounded-full border border-neutral-300 px-3 py-1 text-neutral-700 hover:bg-neutral-100"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {image && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="to send" className="h-12 w-12 rounded object-cover" />
              <button
                onClick={() => setImage(null)}
                className="text-xs text-neutral-500 hover:text-neutral-800 px-1"
                aria-label="Remove image"
              >
                Remove
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickImage}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-2"
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-xl border border-neutral-300 px-3 py-2.5 text-[17px] text-neutral-600 hover:bg-neutral-100"
              aria-label="Attach photo"
            >
              +
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              onPaste={onPaste}
              rows={1}
              name="scout-message"
              autoComplete="off"
              autoCapitalize="sentences"
              autoCorrect="on"
              data-1p-ignore
              data-lpignore="true"
              placeholder="Chat with Scout"
              className="flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2.5 text-[17px] focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
            />
            <button
              type="submit"
              disabled={sending || (!input.trim() && !image)}
              className="rounded-xl bg-neutral-900 px-4 py-2.5 text-[15px] text-white disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/** Minimal markdown: **bold** and line breaks. Keeps responses readable. */
function renderContent(content: string) {
  return content.split("\n").map((line, i) => (
    <span key={i}>
      {renderBold(line)}
      {"\n"}
    </span>
  ));
}

function renderBold(line: string) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}
