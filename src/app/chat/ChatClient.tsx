"use client";

import { useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "chief_of_staff" | "system";
  content: string;
};

const SUGGESTIONS = [
  "What's on tap today?",
  "I'm overwhelmed.",
  "What can I ignore today?",
  "Why this?",
];

export default function ChatClient({
  initialConversationId,
  initialMessages,
}: {
  initialConversationId: string | null;
  initialMessages: Msg[];
}) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
    <div className="flex flex-col h-[calc(100vh-0px)] md:h-screen">
      <header className="border-b border-neutral-200 px-5 py-3 bg-white">
        <h1 className="text-base font-semibold">Talk to Scout</h1>
        <p className="text-xs text-neutral-500">
          Your Chief of Staff. Tell Scout what's going on — it maintains Compass for you.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-neutral-500 mt-10">
              <p className="text-sm">No messages yet.</p>
              <p className="text-sm">Start with “What’s on tap today?”</p>
            </div>
          )}
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
