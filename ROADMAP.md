# Roadmap — Scout Intelligence Layer (Phase 3)

**Design principle:** Scout is the interface. Compass is the implementation.
The user speaks naturally; Scout translates intent into Compass operations.

| Phase | Name | Status |
|---|---|---|
| 3.0 | Access Completion — Scout can read/write/search/reason over every Compass entity | ✅ done |
| 3.1 | Working Agreements — standing instructions that shape Scout's behavior | ✅ done |
| 3.2 | **Crossroads Engine** — recurring-decision tracking ("we've been here before") | ✅ done |
| 3.3 | **Observation Engine** — automatic, quality-first cross-source pattern detection | ✅ done |
| 3.4 | **Briefing Intelligence** — briefings that draw on roles, attention, crossroads, observations, email, calendar | ✅ done |
| 3.5 | **Natural Language Layer** — user never needs Compass terminology | ✅ done |

Build order: **3.3 → 3.4 → 3.5.** Pause for testing after each.
**Phase 3 complete.** 3.5 shipped as `answer_about` (routing/fan-out tool in
`src/lib/answer.ts`) + a routing/voice guide in Scout's system prompt. Verified
across 22 natural-language questions (incl. the 5 ambiguous ones): all routed to
the right reads and answered in plain human language, no Compass terms leaked.

---

## Phase 3.5 — Natural Language Layer (spec; do NOT build yet)

**Goal:** Selena should never need to know Compass terminology. She speaks
naturally; Scout decides which entities to query and synthesizes the answer.

**Principle:** Scout is the interface, Compass is the implementation. The user
should not need to know whether information lives in Roles, Projects, Tasks,
Ideas, Crossroads, Observations, Check-ins, Activity Log, or Working Agreements.

**Intent → translation examples:**

| User says (natural) | Scout translates to (Compass) |
|---|---|
| "What's going on with Mom?" | observations + attention + tasks + crossroads scoped to the Mom role |
| "What decisions am I stuck on?" | active/reopened Crossroads with unresolved concerns |
| "What are you noticing?" | recent open Observations |
| "What's falling through the cracks?" | overdue / long-stale tasks across roles |
| "What am I ignoring?" | neglected roles (low recent attention vs. importance) |

**Architecture notes (for when we build it):**
- This is an *interpretation/routing* layer over the existing tools — not new
  storage. Scout already has read tools for every entity (Phase 3.0); 3.5 is
  about reliably mapping fuzzy natural-language questions to the right
  combination of those tools and synthesizing one human answer.
- Likely a strengthened system-prompt routing guide + few-shot intent→tool
  mappings, possibly a single `answer_about(topic)` helper that fans out across
  entities for "what's going on with X" style questions.
- Never surface schema/jargon in replies (already a working agreement); 3.5
  extends that to *input* — the user never has to phrase things in Compass terms.
- Success test: the five example questions above each return a correct,
  synthesized answer without the user naming any entity.
