import { config } from "dotenv";

// Load env before importing the db client (which validates DATABASE_URL on import).
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { db, roles, integrations } = await import("./index");

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
  ];

  for (const r of seedRoles) {
    const existing = await db.query.roles.findFirst({
      where: (roles, { eq }) => eq(roles.name, r.name),
    });
    if (existing) {
      console.log(`  - ${r.name} already exists, skipping`);
      continue;
    }
    await db.insert(roles).values({ ...r, currentStatus: "maintaining" });
    console.log(`  + ${r.name}`);
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

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
