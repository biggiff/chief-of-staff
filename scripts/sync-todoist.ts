import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { syncTodoist } = await import("../src/lib/integrations/todoist");
  const result = await syncTodoist();
  console.log("Sync result:", JSON.stringify(result));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
