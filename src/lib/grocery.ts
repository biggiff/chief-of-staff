import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { db, groceryPreferences as prefsTable } from "@/db";
import { getSetting } from "./operator";
import {
  resolveProjectAndSections,
  createTodoistTask,
  moveTodoistTask,
  findTaskInProject,
  listActiveTasksInProject,
  todoistEnabled,
} from "./integrations/todoist";

const MODEL = process.env.COS_MODEL_LIGHT || "claude-haiku-4-5";

/**
 * Groceries write into the user's OWN Todoist lists (resolved by id from settings,
 * or by name fallback) and sort into THOSE lists' existing sections — never a
 * parallel project Scout invents. Two lists: "grocery" and "costco".
 */
export type ListKey = "grocery" | "costco";
const LISTS: Record<ListKey, { setting: string; fallbackName: string }> = {
  grocery: { setting: "grocery_project_id", fallbackName: "Grocery List" },
  costco: { setting: "costco_project_id", fallbackName: "Costco List" },
};

// Generic categories the dictionary classifies into; mapped to whatever the
// target list actually calls its sections (see mapGenericToSection).
type Generic = "Produce" | "Dairy" | "Meat & Seafood" | "Frozen" | "Pantry" | "Bakery" | "Household" | "Personal Care";

const DICTIONARY: Record<string, Generic> = {
  apple: "Produce", banana: "Produce", orange: "Produce", lemon: "Produce", lime: "Produce",
  grape: "Produce", strawberr: "Produce", blueberr: "Produce", raspberr: "Produce", berries: "Produce",
  lettuce: "Produce", spinach: "Produce", kale: "Produce", arugula: "Produce", salad: "Produce",
  tomato: "Produce", potato: "Produce", onion: "Produce", garlic: "Produce", carrot: "Produce",
  celery: "Produce", cucumber: "Produce", pepper: "Produce", broccoli: "Produce", cauliflower: "Produce",
  avocado: "Produce", mushroom: "Produce", zucchini: "Produce", squash: "Produce", corn: "Produce",
  cilantro: "Produce", parsley: "Produce", basil: "Produce", ginger: "Produce", herb: "Produce",
  milk: "Dairy", cheese: "Dairy", yogurt: "Dairy", butter: "Dairy", cream: "Dairy",
  egg: "Dairy", "sour cream": "Dairy", "cream cheese": "Dairy", "cottage cheese": "Dairy",
  "half and half": "Dairy", "almond milk": "Dairy", "oat milk": "Dairy", creamer: "Dairy",
  chicken: "Meat & Seafood", beef: "Meat & Seafood", pork: "Meat & Seafood", turkey: "Meat & Seafood",
  bacon: "Meat & Seafood", sausage: "Meat & Seafood", steak: "Meat & Seafood", "ground beef": "Meat & Seafood",
  salmon: "Meat & Seafood", shrimp: "Meat & Seafood", fish: "Meat & Seafood", tuna: "Meat & Seafood",
  ham: "Meat & Seafood", "deli meat": "Meat & Seafood", "hot dog": "Meat & Seafood",
  "ice cream": "Frozen", frozen: "Frozen", "frozen pizza": "Frozen", popsicle: "Frozen", waffle: "Frozen",
  rice: "Pantry", pasta: "Pantry", flour: "Pantry", sugar: "Pantry", salt: "Pantry", oil: "Pantry",
  "olive oil": "Pantry", vinegar: "Pantry", cereal: "Pantry", oatmeal: "Pantry", oats: "Pantry",
  "peanut butter": "Pantry", jelly: "Pantry", jam: "Pantry", honey: "Pantry", canned: "Pantry",
  beans: "Pantry", soup: "Pantry", sauce: "Pantry", ketchup: "Pantry", mustard: "Pantry", mayo: "Pantry",
  spice: "Pantry", broth: "Pantry", "chicken stock": "Pantry", coffee: "Pantry", tea: "Pantry",
  cracker: "Pantry", chip: "Pantry", snack: "Pantry", nut: "Pantry", granola: "Pantry", "baking soda": "Pantry",
  "baking powder": "Pantry", "tomato sauce": "Pantry", salsa: "Pantry", tortilla: "Pantry",
  bread: "Bakery", bagel: "Bakery", bun: "Bakery", roll: "Bakery", muffin: "Bakery", croissant: "Bakery",
  donut: "Bakery", cake: "Bakery", pie: "Bakery", pancake: "Bakery",
  "paper towel": "Household", "toilet paper": "Household", "trash bag": "Household", "dish soap": "Household",
  detergent: "Household", laundry: "Household", bleach: "Household", sponge: "Household",
  ziploc: "Household", foil: "Household", "plastic wrap": "Household", napkin: "Household",
  cleaner: "Household", "light bulb": "Household", batteries: "Household", "paper plate": "Household",
  shampoo: "Personal Care", conditioner: "Personal Care", soap: "Personal Care", "body wash": "Personal Care",
  toothpaste: "Personal Care", toothbrush: "Personal Care", deodorant: "Personal Care", lotion: "Personal Care",
  razor: "Personal Care", shaving: "Personal Care", floss: "Personal Care", feminine: "Personal Care",
  tampon: "Personal Care", pad: "Personal Care", vitamin: "Personal Care", medicine: "Personal Care",
  ibuprofen: "Personal Care", tylenol: "Personal Care", "band-aid": "Personal Care", sunscreen: "Personal Care",
};

// Keywords that map a generic category to whatever the list actually named its section.
const GENERIC_KEYWORDS: Record<Generic, string[]> = {
  Produce: ["produce", "fruit", "vegetable", "veg"],
  Dairy: ["dairy", "egg"],
  "Meat & Seafood": ["meat", "seafood", "poultry", "deli"],
  Frozen: ["frozen", "freezer"],
  Pantry: ["pantry", "bread", "cereal", "rice", "canned", "dry", "baking", "snack"],
  Bakery: ["bakery", "bread"],
  Household: ["household", "home", "cleaning", "paper"],
  "Personal Care": ["personal", "care", "health", "beauty", "pharmacy", "toiletr", "household"],
};

export function normalizeKey(item: string): string {
  return item
    .toLowerCase()
    .replace(/[^a-z0-9 &-]/g, " ")
    .replace(/\b\d+(\.\d+)?\b/g, " ")
    .replace(/\b(lbs?|oz|ounces?|dozen|bunch|bag|box|cans?|bottles?|gallons?|qt|pt|pkg|packs?|count|ct|x|of|a|some)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cleanSection = (s: string) => s.toLowerCase().replace(/[^a-z0-9 &]/g, " ").replace(/\s+/g, " ").trim();

/** Used for fast-path intent routing only (does this look like a grocery item?). */
export function looksLikeGrocery(item: string): boolean {
  return fromDictionary(normalizeKey(item)) !== null;
}

function fromDictionary(key: string): Generic | null {
  const keys = Object.keys(DICTIONARY).sort((a, b) => b.length - a.length);
  for (const kw of keys) if (key === kw || key.includes(kw)) return DICTIONARY[kw];
  return null;
}

/** Map a generic category to the closest real section name in the target list. */
function mapGenericToSection(generic: Generic, sectionNames: string[]): string | null {
  const kws = GENERIC_KEYWORDS[generic];
  for (const name of sectionNames) {
    const c = cleanSection(name);
    if (kws.some((k) => c.includes(k))) return name;
  }
  return null;
}

/** AI fallback: sort unknown items into the list's REAL section names. */
async function categorizeWithAI(items: string[], sectionNames: string[]): Promise<Record<string, string | null>> {
  if (!items.length || !process.env.ANTHROPIC_API_KEY || !sectionNames.length) {
    return Object.fromEntries(items.map((i) => [i, null]));
  }
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      thinking: { type: "disabled" },
      system: `Sort each grocery item into EXACTLY one of these store sections (use the names verbatim): ${sectionNames.join(", ")}. Reply ONLY with a JSON object mapping each item to its section name. If none fit, use null.`,
      messages: [{ role: "user", content: `Items: ${JSON.stringify(items)}` }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
    const out: Record<string, string | null> = {};
    for (const item of items) {
      const s = parsed[item];
      out[item] = sectionNames.find((n) => n === s || cleanSection(n) === cleanSection(s || "")) ?? null;
    }
    return out;
  } catch {
    return Object.fromEntries(items.map((i) => [i, null]));
  }
}

async function learnedMap(): Promise<Map<string, string>> {
  const rows = await db.select().from(prefsTable);
  return new Map(rows.map((r) => [r.itemKey, r.section]));
}

async function resolveList(listKey: ListKey) {
  const cfg = LISTS[listKey];
  const id = (await getSetting(cfg.setting)) || cfg.fallbackName;
  return resolveProjectAndSections(id);
}

export type GroceryAddResult = {
  ok: boolean;
  error?: string;
  list?: string;
  placed: { item: string; section: string | null; via: "learned" | "dictionary" | "ai" }[];
  skipped: string[];
};

/** Categorize + add items to the user's real grocery (or costco) list. */
export async function addGroceries(items: string[], listKey: ListKey = "grocery"): Promise<GroceryAddResult> {
  if (!todoistEnabled()) return { ok: false, error: "Todoist not connected.", placed: [], skipped: [] };
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (!clean.length) return { ok: true, placed: [], skipped: [] };

  const target = await resolveList(listKey);
  if (!target) return { ok: false, error: `Couldn't find your ${listKey} list in Todoist.`, placed: [], skipped: [] };

  const learned = await learnedMap();
  const resolved: GroceryAddResult["placed"] = [];
  const unknown: string[] = [];
  for (const item of clean) {
    const key = normalizeKey(item);
    const learnedName = learned.get(key);
    if (learnedName && target.sectionNames.includes(learnedName)) {
      resolved.push({ item, section: learnedName, via: "learned" });
      continue;
    }
    const generic = fromDictionary(key);
    const mapped = generic ? mapGenericToSection(generic, target.sectionNames) : null;
    if (mapped) resolved.push({ item, section: mapped, via: "dictionary" });
    else unknown.push(item);
  }
  if (unknown.length) {
    const ai = await categorizeWithAI(unknown, target.sectionNames);
    for (const item of unknown) resolved.push({ item, section: ai[item] ?? null, via: "ai" });
  }

  const existing = await listActiveTasksInProject(target.projectId);
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
      await createTodoistTask({
        content: r.item,
        projectId: target.projectId,
        sectionId: r.section ? target.sectionsByName[r.section] : null,
      });
      placed.push(r);
      existingKeys.add(key);
    } catch (err) {
      console.error(`grocery add failed for "${r.item}"`, err);
    }
  }
  return { ok: true, list: target.name, placed, skipped };
}

/** Move an item to a different section in the real list AND remember the preference. */
export async function recategorizeGrocery(item: string, section: string, listKey: ListKey = "grocery"): Promise<{ ok: boolean; message: string }> {
  if (!todoistEnabled()) return { ok: false, message: "Todoist not connected." };
  const target = await resolveList(listKey);
  if (!target) return { ok: false, message: `Couldn't find your ${listKey} list.` };
  const sectionName = target.sectionNames.find((n) => cleanSection(n) === cleanSection(section));
  if (!sectionName) return { ok: false, message: `"${section}" isn't a section on your ${target.name}. Sections: ${target.sectionNames.join(", ")}.` };

  const task = await findTaskInProject(target.projectId, item);
  if (task) await moveTodoistTask(task.id, target.sectionsByName[sectionName]);

  const key = normalizeKey(item);
  const [existing] = await db.select().from(prefsTable).where(eq(prefsTable.itemKey, key)).limit(1);
  if (existing) await db.update(prefsTable).set({ section: sectionName, updatedAt: new Date() }).where(eq(prefsTable.id, existing.id));
  else await db.insert(prefsTable).values({ itemKey: key, section: sectionName });

  return {
    ok: true,
    message: task
      ? `Moved "${task.content}" to ${sectionName} — and I'll keep putting it there.`
      : `Couldn't find "${item}" on the list, but I'll remember it goes in ${sectionName}.`,
  };
}
