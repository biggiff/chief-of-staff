"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "chief_of_staff" | "system";
  content: string;
};

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
        <div className="prose-chat text-[15px] leading-relaxed text-neutral-900 mt-1">
          {glance.opener}
        </div>
      </div>

      {hasToday && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400 mb-1">
            Today
          </div>
          <ul className="space-y-0.5 text-sm text-neutral-700">
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
          <div className="text-sm text-neutral-700">{glance.note}</div>
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const landed = useRef(false);

  useEffect(() => {
    // Land on the glance (top) on first open; only auto-scroll once the
    // conversation is active so new replies stay in view.
    if (!landed.current) {
      landed.current = true;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);

    // Optimistic user bubble.
    const tempId = `temp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content }]);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, content }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      const data = await res.json();
      setConversationId(data.conversationId);
      // Replace optimistic message with the real pair.
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        ...data.messages.map((x: Msg) => ({ id: x.id, role: x.role, content: x.content })),
      ]);
    } catch (e: unknown) {
      setMessages((m) => m.filter((x) => x.id !== tempId));
      setInput(content);
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-2xl space-y-4">
          {glance && <ScoutGlance glance={glance} />}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`prose-chat max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-neutral-900 text-white rounded-br-sm"
                    : "bg-white border border-neutral-200 text-neutral-900 rounded-bl-sm"
                }`}
              >
                {renderContent(m.content)}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-white border border-neutral-200 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-neutral-400">
                thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-neutral-200 bg-white px-4 py-3">
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
          {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Message your Chief of Staff…"
              className="flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
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
