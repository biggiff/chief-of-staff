import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { generateChiefResponse } from "@/lib/chat-engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const content: string = (body?.content ?? "").toString().trim();
    let conversationId: string | undefined = body?.conversationId;

    if (!content) {
      return NextResponse.json({ error: "Message is empty." }, { status: 400 });
    }

    // Create a conversation if one wasn't supplied.
    if (!conversationId) {
      const [conv] = await db
        .insert(conversations)
        .values({ title: content.slice(0, 60) })
        .returning();
      conversationId = conv.id;
    } else {
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    }

    // Load recent history (before inserting the new message) for AI context.
    const priorMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
    const history = priorMessages.map((m) => ({ role: m.role, content: m.content }));

    // Save the user message.
    const [userMsg] = await db
      .insert(messages)
      .values({ conversationId, role: "user", content })
      .returning();

    // Generate + save the Chief of Staff response.
    const reply = await generateChiefResponse(content, history, conversationId);
    const [chiefMsg] = await db
      .insert(messages)
      .values({
        conversationId,
        role: "chief_of_staff",
        content: reply.content,
        metadataJson: reply.metadata,
      })
      .returning();

    return NextResponse.json({
      conversationId,
      messages: [userMsg, chiefMsg],
    });
  } catch (err) {
    console.error("chat error", err);
    return NextResponse.json(
      { error: "Something went wrong handling that message." },
      { status: 500 }
    );
  }
}

// Load the most recent conversation's messages (used to hydrate the chat page).
export async function GET() {
  const [conv] = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  if (!conv) return NextResponse.json({ conversationId: null, messages: [] });

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(messages.createdAt);

  return NextResponse.json({ conversationId: conv.id, messages: msgs });
}
