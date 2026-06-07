import { config } from "dotenv";

// Load env before importing the db client (which validates DATABASE_URL on import).
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db, roles, integrations, workingAgreements } = await import("./index");

  console.log("Seeding roles...");

  const seedRoles = [
    {
      name: "Parent",
      mission:
        "Help my kids build real life skills so they can become independent adults who are thoughtful and kind and always know how much they are loved.",
      desiredState:
        "Kids are building independence, handling age-appropriate responsibilities, coming to trusted adults with problems, and learning to resolve age-appropriate conflicts.",
      warningSigns:
        "I am too reactive, doing things for them that they can do themselves, or feeling generally disconnected.",
      maintenanceMinimum:
        "Kids are fed, have clean clothes, get where they need to be, and basic responsibilities are still expected.",
      importanceLevel: "high" as const,
    },
    {
      name: "House Manager",
      mission:
        "Create and maintain a home that functions well for the family and provides comfort, calm, and preparedness.",
      desiredState:
        "Things are generally put away, systems exist and are being followed, needed items are stocked, everything has a home, and the house is easy to maintain.",
      warningSigns:
        "Clutter or dirt everywhere, dumping grounds, last-minute scrambling, emergency laundry, emergency purchases, and systems not being followed.",
      maintenanceMinimum:
        "Food is available, people have clothes to wear, and the house is sanitary enough to function.",
      importanceLevel: "high" as const,
    },
    {
      name: "Wife",
      mission:
        "Build and maintain a loving, respectful, connected partnership that models healthy relationships for our children.",
      desiredState:
        "We spend intentional time together, operate like a team, enjoy each other's company, and physical intimacy is mutually desired and enjoyed.",
      warningSigns:
        "We stop going to bed together when possible, feel like roommates, lack physical intimacy, or resentment starts building.",
      maintenanceMinimum:
        "Some intentional time together and some form of intimate connection, even if small.",
      importanceLevel: "high" as const,
    },
    {
      name: "Bakery Owner",
      mission:
        "Provide a quality product that customers recognize the value of and want to come back for again and again.",
      desiredState:
        "Customers value the product, repeat customers continue ordering, orders are sustainable, and the business supports the family without consuming too much physical energy.",
      warningSigns:
        "Physical work feels too taxing, direction feels unclear, orders feel draining, or the business consumes energy that should go elsewhere.",
      maintenanceMinimum:
        "Existing orders are fulfilled well, customer communication is handled, and no major commitments are dropped.",
      importanceLevel: "medium" as const,
    },
    {
      name: "Founder",
      mission:
        "Build useful software products that solve real problems and create future leverage beyond direct labor.",
      desiredState:
        "Meaningful progress happens every week, ideas are turned into working systems, and strategic projects are protected from being buried by urgent tasks.",
      warningSigns:
        "No meaningful progress for more than a week, founder work keeps losing to urgent but lower-value tasks, or the project stays in research/planning instead of building.",
      maintenanceMinimum: "At least one meaningful 15-30 minute action per week.",
      importanceLevel: "high" as const,
    },
    {
      name: "PTO Leader",
      mission:
        "Serve the school community effectively in a leadership role without letting it crowd out higher-priority roles.",
      desiredState:
        "Responsibilities (e.g. treasurer duties) are current, commitments are met, and involvement stays proportional — contributing meaningfully without overextending.",
      warningSigns:
        "Deadlines slip, financials/records fall behind, or PTO work expands to consume time that belongs to family or founder work.",
      maintenanceMinimum: "Core obligations handled on time and no commitments dropped.",
      importanceLevel: "medium" as const,
    },
    {
      name: "Coach",
      mission:
        "Help the kids/team I coach grow in skill and character while keeping the commitment sustainable.",
      desiredState:
        "Practices and games are prepared for, players are developing and enjoying it, and coaching energizes rather than drains.",
      warningSigns:
        "Showing up unprepared, dreading sessions, or coaching bleeding into time and energy needed elsewhere.",
      maintenanceMinimum: "Players are coached safely and commitments to the team are kept.",
      importanceLevel: "medium" as const,
    },
    {
      name: "Health",
      mission:
        "Maintain the physical and mental health that everything else depends on.",
      desiredState:
        "Consistent movement, decent sleep, reasonable nutrition, and space to decompress — operating with energy rather than running on empty.",
      warningSigns:
        "Skipping movement, poor sleep, running on caffeine/stress, or no recovery time for an extended stretch.",
      maintenanceMinimum: "Basic sleep, food, and at least minimal movement.",
      importanceLevel: "high" as const,
    },
  ];

  // Only seed roles when there are NONE. Matching by name re-creates roles the
  // user has since renamed (caused duplicate "Parent"/"Founder"). Seeding is a
  // first-run action; renames/edits are managed in-app afterward.
  const anyRole = await db.query.roles.findFirst({});
  if (anyRole) {
    console.log("  - roles already exist, skipping role seed");
  } else {
    for (const r of seedRoles) {
      await db.insert(roles).values({ ...r, currentStatus: "maintaining" });
      console.log(`  + ${r.name}`);
    }
  }

  console.log("Seeding integration placeholders...");
  const providers = [
    "Google Calendar",
    "Todoist",
    "Apple Reminders",
    "Resend",
    "AI Provider",
  ];
  for (const provider of providers) {
    const existing = await db.query.integrations.findFirst({
      where: (integrations, { eq }) => eq(integrations.provider, provider),
    });
    if (existing) {
      console.log(`  - ${provider} already exists, skipping`);
      continue;
    }
    await db.insert(integrations).values({ provider, status: "not_connected" });
    console.log(`  + ${provider}`);
  }

  console.log("Seeding working agreements...");
  const existingAgreements = await db.select().from(workingAgreements).limit(1);
  if (existingAgreements.length === 0) {
    const agreements = [
      { text: "When you recommend a focus, explain the prioritization — say why it, and why not the others.", category: "behavior" },
      { text: "Be concise by default. Expand only when asked.", category: "style" },
      { text: "Challenge avoidance directly but kindly — name it, don't nag.", category: "behavior" },
      { text: "Prefer updating an existing idea over creating a duplicate.", category: "behavior" },
      { text: "Relationship health (Wife) matters — watch the connection, not just logistics.", category: "priority" },
      { text: "Founder is strategic — protect it from being buried by urgent, lower-value tasks.", category: "priority" },
      { text: "Follow Scout's personality: warm, observant, opinionated, lightly funny, no corporate jargon.", category: "style" },
    ];
    for (const a of agreements) {
      await db.insert(workingAgreements).values(a);
      console.log(`  + ${a.text.slice(0, 50)}…`);
    }
  } else {
    console.log("  - working agreements already exist, skipping");
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
