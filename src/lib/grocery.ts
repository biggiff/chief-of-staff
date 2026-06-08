import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db, groceryPreferences as prefsTable } from "@/db";
import {
  ensureProjectWithSections,
  createTodoistTask,
  moveTodoistTask,
  findTaskInProject,
  listActiveTasksInProject,
  todoistEnabled,
} from "./integrations/todoist";

const MODEL = process.env.COS_AI_MODEL || "claude-opus-4-8";
const PROJECT = "Grocery";

export const GROCERY_SECTIONS = [
  "Produce",
  "Dairy",
  "Meat & Seafood",
  "Frozen",
  "Pantry",
  "Bakery",
  "Household",
  "Personal Care",
  "Misc",
] as const;
export type GrocerySection = (typeof GROCERY_SECTIONS)[number];

/** Common grocery items → section. Keys are matched as whole words / substrings. */
const DICTIONARY: Record<string, GrocerySection> = {
  // Produce
  apple: "Produce", banana: "Produce", orange: "Produce", lemon: "Produce", lime: "Produce",
  grape: "Produce", strawberr: "Produce", blueberr: "Produce", raspberr: "Produce", berries: "Produce",
  lettuce: "Produce", spinach: "Produce", kale: "Produce", arugula: "Produce", salad: "Produce",
  tomato: "Produce", potato: "Produce", onion: "Produce", garlic: "Produce", carrot: "Produce",
  celery: "Produce", cucumber: "Produce", pepper: "Produce", broccoli: "Produce", cauliflower: "Produce",
  avocado: "Produce", mushroom: "Produce", zucchini: "Produce", squash: "Produce", corn: "Produce",
  cilantro: "Produce", parsley: "Produce", basil: "Produce", ginger: "Produce", herb: "Produce",
  // Dairy
  milk: "Dairy", cheese: "Dairy", yogurt: "Dairy", butter: "Dairy", cream: "Dairy",
  egg: "Dairy", "sour cream": "Dairy", "cream cheese": "Dairy", "cottage cheese": "Dairy",
  "half and half": "Dairy", "almond milk": "Dairy", "oat milk": "Dairy", creamer: "Dairy",
  // Meat & Seafood
  chicken: "Meat & Seafood", beef: "Meat & Seafood", pork: "Meat & Seafood", turkey: "Meat & Seafood",
  bacon: "Meat & Seafood", sausage: "Meat & Seafood", steak: "Meat & Seafood", "ground beef": "Meat & Seafood",
  salmon: "Meat & Seafood", shrimp: "Meat & Seafood", fish: "Meat & Seafood", tuna: "Meat & Seafood",
  ham: "Meat & Seafood", "deli meat": "Meat & Seafood", "hot dog": "Meat & Seafood",
  // Frozen
  "ice cream": "Frozen", frozen: "Frozen", "frozen pizza": "Frozen", popsicle: "Frozen", waffle: "Frozen",
  // Pantry
  rice: "Pantry", pasta: "Pantry", flour: "Pantry", sugar: "Pantry", salt: "Pantry", oil: "Pantry",
  "olive oil": "Pantry", vinegar: "Pantry", cereal: "Pantry", oatmeal: "Pantry", oats: "Pantry",
  "peanut butter": "Pantry", jelly: "Pantry", jam: "Pantry", honey: "Pantry", "canned": "Pantry",
  beans: "Pantry", soup: "Pantry", sauce: "Pantry", ketchup: "Pantry", mustard: "Pantry", mayo: "Pantry",
  spice: "Pantry", broth: "Pantry", "chicken stock": "Pantry", coffee: "Pantry", tea: "Pantry",
  cracker: "Pantry", chip: "Pantry", snack: "Pantry", nut: "Pantry", granola: "Pantry", "baking soda": "Pantry",
  "baking powder": "Pantry", "tomato sauce": "Pantry", salsa: "Pantry", tortilla: "Pantry",
  // Bakery
  bread: "Bakery", bagel: "Bakery", bun: "Bakery", roll: "Bakery", muffin: "Bakery", croissant: "Bakery",
  donut: "Bakery", cake: "Bakery", pie: "Bakery",
  // Household
  "paper towel": "Household", "toilet paper": "Household", "trash bag": "Household", "dish soap": "Household",
  detergent: "Household", "laundry": "Household", bleach: "Household", sponge: "Household",
  "ziploc": "Household", foil: "Household", "plastic wrap": "Household", "napkin": "Household",
  "cleaner": "Household", "light bulb": "Household", batteries: "Household", "paper plate": "Household",
  // Personal Care
  shampoo: "Personal Care", conditioner: "Personal Care", soap: "Personal Care", "body wash": "Personal Care",
  toothpaste: "Personal Care", toothbrush: "Personal Care", deodorant: "Personal Care", lotion: "Personal Care",
  razor: "Personal Care", "shaving": "Personal Care", floss: "Personal Care", "feminine": "Personal Care",
  tampon: "Personal Care", pad: "Personal Care", "vitamin": "Personal Care", medicine: "Personal Care",
  ibuprofen: "Personal Care", tylenol: "Personal Care", "band-aid": "Personal Care", sunscreen: "Personal Care",
};

export function normalizeKey(item: string): string {
  return item
    .toLowerCase()
    .replace(/[^a-z0-9 &-]/g, " ")
    .replace(/\b\d+(\.\d+)?\b/g, " ") // drop quantities
    .replace(/\b(lbs?|oz|ounces?|dozen|bunch|bag|box|cans?|bottles?|gallons?|qt|pt|pkg|packs?|count|ct|x|of|a|some)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fromDictionary(key: string): GrocerySection | null {
  // Prefer longer (more specific) keyword matches first.
  const keys = Object.keys(DICTIONARY).sort((a, b) => b.length - a.length);
  for (const kw of keys) {
    if (key === kw || key.includes(kw)) return DICTIONARY[kw];
  }
  return null;
}

async function categorizeWithAI(items: string[]): Promise<Record<string, GrocerySection>> {
  if (!items.length || !process.env.ANTHROPIC_API_KEY) {
    return Object.fromEntries(items.map((i) => [i, "Misc" as GrocerySection]));
  }
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      thinking: { type: "disabled" },
      system: `You sort grocery items into exactly one of these store sections: ${GROCERY_SECTIONS.join(", ")}. Reply ONLY with a JSON object mapping each item to its section. If unsure, use "Misc".`,
      messages: [{ role: "user", content: `Items: ${JSON.stringify(items)}` }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
    const out: Record<string, GrocerySection> = {};
    for (const item of items) {
      const s = parsed[item];
      out[item] = (GROCERY_SECTIONS as readonly string[]).includes(s) ? (s as GrocerySection) : "Misc";
    }
    return out;
  } catch {
    return Object.fromEntries(items.map((i) => [i, "Misc" as GrocerySection]));
  }
}

async function learnedMap(): Promise<Map<string, GrocerySection>> {
  const rows = await db.select().from(prefsTable);
  return new Map(rows.map((r) => [r.itemKey, r.section as GrocerySection]));
}

export type GroceryAddResult = {
  ok: boolean;
  error?: string;
  placed: { item: string; section: GrocerySection; via: "learned" | "dictionary" | "ai" }[];
  skipped: string[]; // already on the list
};

/** Categorize + add items to the Grocery project under the right sections. */
export async function addGroceries(items: string[]): Promise<GroceryAddResult> {
  if (!todoistEnabled()) return { ok: false, error: "Todoist not connected.", placed: [], skipped: [] };
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (!clean.length) return { ok: true, placed: [], skipped: [] };

  const { projectId, sections } = await ensureProjectWithSections(PROJECT, [...GROCERY_SECTIONS]);
  const learned = await learnedMap();

  // Resolve each item's section: learned override → dictionary → (collect for AI).
  const resolved: { item: string; section: GrocerySection; via: "learned" | "dictionary" | "ai" }[] = [];
  const unknown: string[] = [];
  for (const item of clean) {
    const key = normalizeKey(item);
    const fromLearned = learned.get(key);
    if (fromLearned) resolved.push({ item, section: fromLearned, via: "learned" });
    else {
      const dict = fromDictionary(key);
      if (dict) resolved.push({ item, section: dict, via: "dictionary" });
      else unknown.push(item);
    }
  }
  if (unknown.length) {
    const ai = await categorizeWithAI(unknown);
    for (const item of unknown) resolved.push({ item, section: ai[item] ?? "Misc", via: "ai" });
  }

  // Dedupe against the existing list — fetched ONCE (not per item, which used to
  // re-pull the whole task list N times and time the whole turn out).
  const existing = await listActiveTasksInProject(projectId);
  const existingKeys = new Set(existing.map((t) => normalizeKey(t.content)));

  const placed: GroceryAddResult["placed"] = [];
  const skipped: string[] = [];
  for (const r of resolved) {
    const key = normalizeKey(r.item);
    if (existingKeys.has(key)) {
      skipped.push(r.item);
      continue;
    }
    try {
      await createTodoistTask({ content: r.item, projectId, sectionId: sections[r.section] });
      placed.push(r);
      existingKeys.add(key); // guard against dupes within this same batch
    } catch (err) {
      console.error(`grocery add failed for "${r.item}"`, err);
    }
  }
  return { ok: true, placed, skipped };
}

/** Move a grocery item to a different section AND remember the preference. */
export async function recategorizeGrocery(item: string, section: string): Promise<{ ok: boolean; message: string }> {
  const target = GROCERY_SECTIONS.find((s) => s.toLowerCase() === section.toLowerCase());
  if (!target) return { ok: false, message: `"${section}" isn't a grocery section. Use one of: ${GROCERY_SECTIONS.join(", ")}.` };
  if (!todoistEnabled()) return { ok: false, message: "Todoist not connected." };

  const { projectId, sections } = await ensureProjectWithSections(PROJECT, [...GROCERY_SECTIONS]);
  const task = await findTaskInProject(projectId, item);
  if (task) await moveTodoistTask(task.id, sections[target]);

  // Learn it regardless (so future adds land right even if the task wasn't found now).
  const key = normalizeKey(item);
  const [existing] = await db.select().from(prefsTable).where(eq(prefsTable.itemKey, key)).limit(1);
  if (existing) await db.update(prefsTable).set({ section: target, updatedAt: new Date() }).where(eq(prefsTable.id, existing.id));
  else await db.insert(prefsTable).values({ itemKey: key, section: target });

  return {
    ok: true,
    message: task
      ? `Moved "${task.content}" to ${target} — and I'll keep putting it there.`
      : `Couldn't find "${item}" on the list, but I'll remember it goes in ${target}.`,
  };
}
