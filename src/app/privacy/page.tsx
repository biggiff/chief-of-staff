export const dynamic = "force-static";

export const metadata = {
  title: "Privacy Policy — Scout",
  description: "Privacy policy for the Scout personal assistant SMS service.",
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px", lineHeight: 1.6, color: "#1a1a1a", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: June 10, 2026</em></p>

      <p>
        Scout is a private, single-user personal productivity assistant operated by Selena Gifford.
        This policy explains how the Scout SMS (text message) service handles personal information.
      </p>

      <h2>Who this service is for</h2>
      <p>
        Scout is used by one person only — the account owner. It is a personal tool for capturing
        tasks, grocery items, reminders, and notes, and for receiving brief confirmations, reminders
        the owner requests, and optional daily and weekly summaries. Scout does not message the
        general public and is not used for marketing.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>The account owner&apos;s mobile phone number.</li>
        <li>The content of text messages the account owner sends to the service, and the responses sent back.</li>
        <li>The tasks, reminders, and notes the owner chooses to record.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        This information is used solely to operate the personal assistant for the account owner — to
        record and retrieve their tasks and reminders and to send the confirmations, reminders, and
        summaries they ask for. It is not used for advertising or marketing.
      </p>

      <h2>Sharing</h2>
      <p>
        We do not sell, rent, or share personal information or message content with third parties for
        their own purposes. Information is processed only by the service providers used to operate the
        assistant (for example, the SMS carrier and hosting provider) and is never shared for
        promotional purposes. <strong>No mobile information is shared with third parties or affiliates
        for marketing or promotional purposes.</strong>
      </p>

      <h2>Consent and opt-out</h2>
      <p>
        The account owner consents to receive text messages by enabling text notifications in the
        application and by texting the service from their own phone. Message frequency varies based on
        use. Message and data rates may apply. The owner can opt out at any time by replying{" "}
        <strong>STOP</strong>, and can reply <strong>HELP</strong> for assistance.
      </p>

      <h2>Data retention and security</h2>
      <p>
        Information is retained only as long as needed to operate the assistant and is protected with
        reasonable security measures. The account owner may request deletion of their data at any time.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy can be directed to the account owner at{" "}
        <a href="mailto:selena.gifford@gmail.com">selena.gifford@gmail.com</a>.
      </p>
    </main>
  );
}
