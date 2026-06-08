import { desc, eq } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { getHomeGlance, type HomeGlance } from "@/lib/briefing";
import ChatClient from "./ChatClient";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Dev/testing mode: /chat?new (or ?fresh) starts a brand-new conversation with
  // ZERO prior messages — but Compass + Memory + Tools still load normally. This
  // is how you verify Scout reconstructs your life from stored data alone, not
  // from the persistent chat thread.
  const sp = await searchParams;
  const fresh = sp.new !== undefined || sp.fresh !== undefined;

  const [conv] = fresh
    ? [null]
    : await db
        .select()
        .from(conversations)
        .orderBy(desc(conversations.updatedAt))
        .limit(1);

  let initialMessages: {
    id: string;
    role: "user" | "chief_of_staff" | "system";
    content: string;
    image?: string | null;
  }[] = [];
  if (conv) {
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(messages.createdAt);
    initialMessages = msgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      image: (m.metadataJson as { image?: string } | null)?.image ?? null,
    }));
  }

  // Skip the voiced glance in fresh mode — its opener can quote recent
  // conversation, which would defeat a "stored data only" test.
  let glance: HomeGlance | null = null;
  if (!fresh) {
    try {
      glance = await getHomeGlance();
    } catch (err) {
      console.error("home glance failed", err);
    }
  }

  return (
    <ChatClient
      initialConversationId={conv?.id ?? null}
      initialMessages={initialMessages}
      glance={glance}
      fresh={fresh}
    />
  );
}
