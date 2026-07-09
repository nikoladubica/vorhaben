# Vorhaben — Business Logic

> **What this app is:** a tracker for a person's income-generating projects. It shows what you
> work on and which job, gig, or product gives you the best value for your time and effort.
>
> **What this app is NOT:** a digital wallet, a portfolio manager, or an accounting tool. It
> does not hold funds, connect to banks or exchanges, or file taxes. All figures are
> self-reported by the user for their own insight.

## 1. Core concept: the Project

Everything the user tracks is a **project** (a *Vorhaben*). A project is any income source or
undertaking the user wants to measure.

### 1.1 Project types

| Type | Examples |
|---|---|
| `job` | Full-time or part-time employment |
| `freelance_gig` | One-off freelance engagement |
| `freelance_client` | Ongoing client relationship (may contain many gigs) |
| `contract` | Fixed-term contract work |
| `project` | Self-driven project (side project, startup effort) |
| `commission` | Commissioned work (art, referral commissions, sales commissions) |
| `margin` | Margin on something bought and resold (flipping, retail arbitrage) |
| `loan_interest` | Interest earned on money lent out |
| `stock` | Stock trading income (realized gains) |
| `dividend` | Dividend income from holdings |
| `product` | A product the user sells (SaaS, e-book, physical product) |
| `other` | Anything else — e.g. selling crypto, royalties, one-off windfalls |

The type list should be extensible: types are stored as data (a lookup/enum kept in one place),
so adding a new type later is a migration, not a refactor.

### 1.2 Project fields

- **Name** — required, short label.
- **Type** — one of the types above, required.
- **Description** — free text describing the project.
- **Start date** — when the user started (required).
- **End date** — when the user stopped; `NULL` means ongoing/active.
- **Status** — derived + manual: `active`, `paused`, `ended`, `idea` (not yet started).
- **Compensation model** — see §2.
- **Revenue fields** — see §2.
- **Notes** — Markdown notes, see §3.
- **Currency** — per project (users may earn in multiple currencies).
- **Tags** — free-form labels for grouping/filtering (e.g. `remote`, `passive`, `2026`).

### 1.3 Lifecycle rules

- A project with no end date is **active**.
- Setting an end date of **today or in the past** marks it **ended**; a future end date keeps it active until that date.
- `paused` is a manual flag — the project is neither earning nor ended (e.g. a client on hold).
- End date must be ≥ start date.
- Ended projects are never deleted by default — history is the whole point. Deletion is
  explicit and confirmed (soft-delete with a grace period).

## 2. Compensation & revenue

Each project has a **compensation model** that determines how revenue is entered and how the
app normalizes it for comparison:

| Model | Input fields | Normalization |
|---|---|---|
| `hourly` | rate, currency, (optional) hours logged per period | rate × hours → monthly equivalent |
| `salary_monthly` | amount per month | as-is |
| `salary_biweekly` | amount per 2 weeks | × 26 ÷ 12 → monthly |
| `salary_weekly` | amount per week | × 52 ÷ 12 → monthly |
| `fixed` | one-time total amount | spread over project duration for rate comparisons |
| `commission` | percentage + base, or per-event amount | sum of recorded events per period |
| `variable` | free entries (for margin, dividends, crypto sales…) | sum of recorded income entries per period |

### 2.1 Income entries

For non-salaried models the user records **income entries**: dated amounts attached to a
project (e.g. "sold 3 units, €240, 2026-07-01"). Salaried models can auto-generate expected
entries, which the user can adjust.

- Entry: `project_id`, `date`, `amount`, `currency`, optional note.
- Entries drive all dashboard math; the compensation model just sets defaults and expectations.

### 2.2 Normalization (the key business rule)

To compare a €50/h gig against a €4,000/month job against a product making €300/month, every
project gets a computed **monthly-equivalent revenue** and, where hours are tracked, an
**effective hourly rate** (revenue ÷ hours). These two numbers power the dashboard rankings.

- Fixed one-time payments are amortized across the project's active duration.
- Multi-currency: convert to the user's base currency using a stored rate (manually set or
  periodically fetched); store the original amount + currency, never overwrite.

## 3. Notes (Markdown)

- Every project has notes supporting **Markdown** (headings, lists, links, code, tables).
- Multiple notes per project, each with created/updated timestamps — a lightweight journal,
  not a single blob (a single blob gets unwieldy for long-running projects).
- Rendered safely (sanitized HTML) on the client.

### 3.1 Mood check-ins

- A one-tap "how do you feel about this project?" rating (1–5), offered when the user adds an
  income entry or a note — always skippable, never a mandatory field, never nagged.
- Each reading is a dated row (see `project_moods` in §6) — history is kept, nothing is
  averaged away or overwritten.
- Readings carry a `source`: `user` (explicit check-in) or `llm` (sentiment backfilled from
  notes, §7). LLM readings never overwrite or replace user readings.
- Core feature: works fully self-hosted with no LLM — the LLM only augments it (§7).

## 4. Dashboard

The dashboard answers one question: **"Where is my time best spent?"**

### 4.1 Views

- **Best performers** — projects ranked by monthly-equivalent revenue and by effective hourly
  rate (two rankings; they often disagree, and that disagreement is the insight).
- **Focus suggestion** — a plain-language callout, e.g. *"Your freelance client X pays 2.3×
  your effective hourly rate at job Y. Consider shifting hours."* Rules-based at first
  (see §7 for the LLM upgrade path).
- **Timeline** — active projects over time (start/end dates as a Gantt-style strip), so the
  user sees overlap and load.
- **Trend** — total monthly income over the last N months, stacked by project.
- **Composition** — income share by project type (how dependent am I on one source?).
- **Feelings vs. facts** — per-project chart: monthly-equivalent revenue and monthly-averaged
  mood (§3.1) on the same time axis. The divergence is the insight: thriving revenue with
  sliding mood is a burnout warning; a loved project that's objectively dying is sunk-cost
  bias made visible. Mood readings are sparse — bucket per month and show gaps honestly
  (dots, not an interpolated line) when a month has no reading.

### 4.2 Suggested focus heuristics (v1, no LLM)

1. Highest effective hourly rate among active projects → "do more of this."
2. Active project with declining 3-month revenue trend → "check on this."
3. Ended project that outperformed all active ones → "consider reviving."
4. >60% of income from one project → "concentration risk."
5. Revenue trend up + mood trend down over 3 months (§3.1) → "burnout risk — consider raising
   rates or reducing hours."

## 5. Users & hosting model

- **Open source, self-hostable**: anyone can run the full app themselves; no features are
  crippled in the self-hosted version's core (tracking, dashboard, notes all work).
- **Paid hosted version**: we run it, user pays for hosting convenience + hosted-only
  conveniences (managed backups, LLM tokens in §7, sync).
- Single-user first: one account owns all projects. Design tables with `user_id` from day one
  so the hosted multi-tenant version needs no schema surgery.
- Auth: email + password to start; OAuth later for hosted.

## 6. Data model sketch

```
users            id, email, password_hash, base_currency, created_at
projects         id, user_id, name, type, description, status,
                 start_date, end_date, compensation_model,
                 rate_amount, rate_currency, created_at, updated_at, deleted_at
income_entries   id, project_id, date, amount, currency, note, created_at
notes            id, project_id, title, body_md, created_at, updated_at
project_moods    id, project_id, score, source (user|llm), note_id, recorded_at
tags             id, user_id, name
project_tags     project_id, tag_id
fx_rates         currency, base_currency, rate, as_of
```

## 7. Later: LLM assistance (hosted / bring-your-own-key)

- User buys **tokens/credits** on the hosted version (or supplies their own API key when
  self-hosting) to unlock LLM-powered analysis.
- The LLM reads the user's projects, entries, and notes and produces richer suggestions:
  spotting patterns the heuristics miss, summarizing notes, drafting "what should I drop?"
  reviews, answering free-form questions about the data. Notes are the data the numeric
  heuristics can't see — the LLM's distinct value is correlating qualitative friction in notes
  with quantitative trends in entries, not re-deriving trends the heuristics already compute.
- **On-demand, not background.** Analysis runs when the user asks ("Analyze this project",
  "What should I focus on?") — never as an always-on daemon silently spending hosted credits
  or a self-hoster's API key. The one proactive touchpoint is the **monthly email digest**
  (§8), which is opt-in and cost-transparent.
- **Incremental summaries** keep runs cheap: store a per-project note summary, re-summarize
  only notes whose `updated_at` is newer than the last run, and feed summaries (not raw
  markdown) into dashboard-level analysis.
- **Mood augmentation (§3.1):** the LLM can backfill sentiment from existing notes as dated
  `project_moods` rows with `source: llm` (linked to the note via `note_id`), and annotate
  the feelings-vs-facts chart with *why* the line moved (e.g. "mood dipped when notes started
  mentioning scope creep"). It never overwrites user check-ins; the chart and heuristic #5
  work fully without it.
- Suggestions are phrased as observations, not predictions — "X pays 2.3× your rate at Y, and
  your notes mention burnout at Y three times", never "focus on X and you'll earn more". The
  product disclaimer holds: self-reported tracking, not advice.
- Strict scoping: the LLM only ever sees that user's own data; nothing is used for training;
  notes (the most sensitive data — client names, figures, complaints) are never sent to an
  API without an explicit user action or opt-in.
- Keep all v1 heuristics working without the LLM — it augments, never gates.

---

## 8. Suggested features (beyond the brief)

**High value, low effort**
- **Time/effort logging** — even rough weekly hours per project. Without hours, "best value"
  can only mean "most revenue"; with hours, the effective-hourly-rate ranking becomes the
  app's killer insight.
- **Expenses per project** — a margin or product project isn't understood by revenue alone.
  One `expense_entries` table mirroring income entries turns revenue into *profit*, and the
  disclaimer still holds: it's self-reported tracking, not accounting.
- **CSV export / import** — self-hosters and spreadsheet people will demand it; it's also the
  honest answer to "what if I want to leave?"
- **Archive & compare** — "2025 vs 2026" year-over-year view per project.

**Medium effort**
- **Goals** — per-project or overall monthly income target with progress on the dashboard.
- **Reminders** — "you haven't logged income for *Client X* in 5 weeks" (also catches dead
  projects silently rotting in the active list).
- **Recurring entry templates** — for dividends/salary: auto-create the expected entry, user
  confirms or edits.
- **Public read-only share link** *(hosted)* — share a redacted dashboard (percentages, no
  absolute amounts) for accountability threads / indie-hacker transparency posts.

**Later / hosted differentiators**
- **Email digest** — monthly summary: best performer, trend, one suggestion. Also the single
  proactive LLM touchpoint (§7): opt-in, one scheduled run per month, cost-transparent.
- **Scenario mode** — "what if I drop project X and put those hours into Y?" using the
  effective hourly rates already computed.
- **API + webhooks** — let Stripe/Gumroad et al. push income entries automatically for
  product-type projects.
- **Mobile-friendly quick-add** — logging an income entry must take <10 seconds or people
  stop doing it.
