import { desc, eq } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import ChatClient from "./ChatClient";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const [conv] = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  let initialMessages: { id: string; role: "user" | "chief_of_staff" | "system"; content: string }[] = [];
  if (conv) {
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(messages.createdAt);
    initialMessages = msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }));
  }

  return (
    <ChatClient
      initialConversationId={conv?.id ?? null}
      initialMessages={initialMessages}
    />
  );
}
