import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, authEnabled, expectedToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Public landing page. Logged-in users are sent straight to the app; everyone
 * else (including carrier/A2P reviewers) sees a real, verifiable description of
 * the service — not a login wall. This is what makes the website "verifiable"
 * for SMS campaign registration.
 */
export default async function Home() {
  if (authEnabled()) {
    const cookie = (await cookies()).get(AUTH_COOKIE)?.value;
    if (cookie && cookie === (await expectedToken())) redirect("/chat");
  } else {
    redirect("/chat");
  }

  const wrap: React.CSSProperties = { maxWidth: 720, margin: "0 auto", padding: "56px 20px", fontFamily: "system-ui, -apple-system, sans-serif", color: "#1a1a1a", lineHeight: 1.6 };

  return (
    <main style={wrap}>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.02em", marginBottom: 8 }}>Scout</h1>
      <p style={{ fontSize: 20, color: "#444", marginTop: 0 }}>
        A personal chief of staff you can text. Capture a thought, get a quick confirmation, move on.
      </p>

      <p style={{ marginTop: 24 }}>
        Scout is a private, single-user assistant. The account owner texts Scout to capture tasks,
        grocery items, reminders, and notes, and gets back brief confirmations, the reminders they
        ask for, and an optional daily and weekly summary. It is a personal productivity tool — not a
        marketing service, and it never messages anyone but the account owner.
      </p>

      <h2 style={{ fontSize: 22, marginTop: 36 }}>How the text messaging works</h2>
      <ul>
        <li>The account owner opts in by signing into this application and enabling text notifications, and by texting Scout from their own phone.</li>
        <li>Message frequency varies based on use. Message and data rates may apply.</li>
        <li>Reply <strong>STOP</strong> at any time to opt out, or <strong>HELP</strong> for help.</li>
        <li>No mobile information is shared with third parties or affiliates for marketing or promotional purposes.</li>
      </ul>

      <p style={{ marginTop: 28 }}>
        <Link href="/privacy">Privacy Policy</Link>
        {"  ·  "}
        <Link href="/login">Sign in</Link>
      </p>

      <p style={{ marginTop: 40, fontSize: 13, color: "#888" }}>
        Scout is operated by Selena Gifford. Questions: selena.gifford@gmail.com
      </p>
    </main>
  );
}
