# Chief of Staff

A personal, conversation-first Chief of Staff web app. You manage your life by **roles**
(Parent, House Manager, Wife, Bakery Owner, Founder, …), and the app interprets *role health* —
not just task lists — to tell you where your attention should go each day.

This is **not** a dashboard-first productivity tool. The primary surface is `/chat`: you text
your Chief of Staff like a trusted assistant. The database/admin pages exist for reliability,
transparency, editing, and structured memory underneath.

## What's in this foundation (v1)

- **Conversation-first chat** (`/chat`) with saved conversations + messages and a **rule-based**
  Chief of Staff (no external AI calls yet). It can:
  - generate/retrieve today's briefing for "What's on tap today?"
  - explain its reasoning on "why?"
  - capture ideas (`idea: ...`) and tasks (`task: ...`), inferring role/project when obvious
  - handle overwhelm ("I'm overwhelmed") by shrinking the day to one action
  - accept pushback ("I don't want to work on Founder today") — offers a lower-friction step
    but **keeps the neglected role flagged** and records the avoidance
- **Rule-based briefing engine** that scores roles on status, latest check-in health, overdue
  high-priority tasks, stalled strategic projects, neglect, and task avoidance — then picks one
  focus role and outputs *why this / why now / why not the others / next 15-min action /
  safe to ignore / avoidance alerts*. Every point is auditable.
- **Support pages**: Dashboard, Roles (+ detail), Projects, Tasks, Ideas, Check-in, Briefing,
  Decisions, Integrations (placeholder), Settings — all with create/edit/archive where relevant.
- **Seeded** with your five roles and integration placeholders.

Not included by design (yet): auth, Google Calendar, Todoist, Apple Reminders, Resend/email,
external AI calls.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- Neon Postgres
- Drizzle ORM (chosen over Prisma — lighter, no codegen step, plays well with serverless/Vercel)

## Run locally

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up the database** — create a Neon project and copy the **pooled** connection string.

   ```bash
   cp .env.example .env.local
   # then edit .env.local and paste your DATABASE_URL
   ```

3. **Create the tables** (pushes the Drizzle schema straight to Neon):

   ```bash
   npm run db:push
   ```

4. **Seed roles + integration placeholders**:

   ```bash
   npm run db:seed
   ```

5. **Start the app**:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000 — it redirects to `/chat`. Try **"What's on tap today?"**

## Environment variables

| Variable       | Required | Description                                                        |
| -------------- | -------- | ------------------------------------------------------------------ |
| `DATABASE_URL` | yes      | Neon Postgres connection string (use the **pooled** `-pooler` URL) |

## Scripts

| Script             | What it does                              |
| ------------------ | ----------------------------------------- |
| `npm run dev`      | Start the dev server                      |
| `npm run build`    | Production build                          |
| `npm run start`    | Run the production build                  |
| `npm run db:push`  | Push the Drizzle schema to the database   |
| `npm run db:seed`  | Seed roles + integration placeholders     |
| `npm run db:studio`| Open Drizzle Studio to browse data        |

## Deploying to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel.
3. Add `DATABASE_URL` as an environment variable.
4. Run `npm run db:push` and `npm run db:seed` once against your production database.

## Project structure

```
src/
  app/
    chat/            # primary experience (client chat + server-loaded history)
    dashboard/ roles/ projects/ tasks/ ideas/ checkin/ briefing/ decisions/ integrations/ settings/
    api/chat/        # POST: save msg + generate reply; GET: load latest conversation
    actions.ts       # server actions (CRUD for every entity)
  components/         # Nav + shared UI primitives
  db/
    schema.ts        # Drizzle schema (11 tables)
    index.ts         # Neon + Drizzle client
    seed.ts          # seed script
  lib/
    briefing.ts      # rule-based scoring + briefing generation
    chat-engine.ts   # rule-based Chief of Staff response logic
    dates.ts         # date helpers
```

## How the briefing logic works

`scoreRoles()` in `src/lib/briefing.ts` walks every active role and accumulates an **attention
score** from independent, labeled signals:

- current status (critical/needs_attention add pressure; thriving subtracts)
- latest self-rated health score from the most recent check-in
- overdue high-priority tasks
- repeated task avoidance (`avoidance_count`)
- active projects with no recent progress, weighted by strategic importance
- days since the role got meaningful attention
- a gentle importance multiplier

The highest score becomes the day's focus. Because each contribution carries a human-readable
label, the recommendation is fully explainable — that's what powers "why?".

## AI layer (Claude)

The chat uses a real AI Chief of Staff (Anthropic Claude) when `ANTHROPIC_API_KEY` is set, and
falls back to the deterministic rule-based engine otherwise (or if the API call errors). The
design keeps the **rule-based scoring engine as the auditable backbone**:

- The model receives the *current structured state* (roles, attention scores, latest briefing)
  in its system prompt — it interprets, it doesn't invent facts.
- All state changes go through deterministic tools (`get_or_generate_briefing`, `create_task`,
  `create_idea`, `record_role_pushback`) — never free-form writes.
- Uses `claude-opus-4-8` by default (adaptive thinking); override with `COS_AI_MODEL`
  (e.g. `claude-sonnet-4-6` or `claude-haiku-4-5`) for lower cost/latency.

See `src/lib/ai.ts`. No key? Everything still works via `src/lib/chat-engine.ts`.

## Next recommended build step

**Connect a real data source** — Google Calendar or Todoist — so the briefing can weigh actual
time pressure and external tasks, not just what's entered by hand. The integrations data model
and placeholder UI are already in place.
