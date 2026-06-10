import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc, ne } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { generateChiefResponse } from "@/lib/chat-engine";

export const dynamic = "force-dynamic";
// A full turn (Opus + adaptive thinking + a multi-tool loop) can run well past the
// default ~10s function limit; without this the function is killed mid-generation,
// so no reply is ever produced or saved (the "thinking… then nothing" symptom).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const content: string = (body?.content ?? "").toString().trim();
    let conversationId: string | undefined = body?.conversationId;

    // Optional image: a "data:<mime>;base64,<data>" URL from the client.
    const imageUrl: string | undefined = body?.image;
    let image: { data: string; mediaType: string } | undefined;
    if (imageUrl?.startsWith("data:")) {
      const m = imageUrl.match(/^data:(.+?);base64,(.*)$/s);
      if (m) image = { mediaType: m[1], data: m[2] };
    }

    if (!content && !image) {
      return NextResponse.json({ error: "Message is empty." }, { status: 400 });
    }

    // Create a conversation if one wasn't supplied.
    if (!conversationId) {
      const [conv] = await db
        .insert(conversations)
        .values({ title: (content || "Photo").slice(0, 60) })
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

    // Save the user message (store the image in metadata so it persists in history).
    const [userMsg] = await db
      .insert(messages)
      .values({
        conversationId,
        role: "user",
        content: content || "📷 Photo",
        metadataJson: image ? { image: imageUrl } : null,
      })
      .returning();

    // Generate + save the Chief of Staff response.
    const reply = await generateChiefResponse(content, history, conversationId, image);
    const [chiefMsg] = await db
      .insert(messages)
      .values({
        conversationId,
        role: "chief_of_staff",
        content: reply.content,
        metadataJson: reply.metadata,
      })
      .returning();

    // Refresh the Todoist mirror AFTER the reply is sent — never on the critical
    // path (this used to add up to ~7s to a turn). Throttled internally to 10 min.
    after(async () => {
      try {
        const { syncTodoistIfStale } = await import("@/lib/integrations/todoist");
        await syncTodoistIfStale();
      } catch (err) {
        console.error("post-response todoist sync failed", err);
      }
    });

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
// Excludes the SMS thread — that's its own surface.
export async function GET() {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(ne(conversations.title, "📱 Texts"))
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
