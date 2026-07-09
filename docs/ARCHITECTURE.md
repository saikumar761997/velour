# Velour — Salon Management Platform (Source of Truth)

Velour is an **AI-first operating system for independent nail salons**. First live client: **Red Persimmon Nails & Spa** (Manchester, NH; owner Kristy). Long-term goal: a **multi-tenant** platform where each salon is *configuration, not custom code*.

This doc is the product + engineering + business source of truth and the handoff summary for any new chat. **Update it after each milestone.**

---

## 1. Vision & strategy

- **Wedge:** the best AI-powered operating system for independent nail salons — not a feature-for-feature clone of Fresha/GlossGenius.
- **Differentiator:** the complete ecosystem — Website → Booking → CRM → Dashboard → Customer Aivy → Owner Aivy — not just a chatbot. **Aivy is the core brand.**
- **Stage goal:** get the first **5–10 paying salons**. Prove demand and repeatability before scaling features.
- **Feature filter:** every feature must (1) increase salon revenue, (2) reduce owner workload, or (3) improve customer experience. If not, don't build it.
- **Current #1 risk:** "will salons other than Kristy pay?" — unproven. Priority is a real-world test with Red Persimmon, then client #2.

---

## 2. Stack & key IDs

- **Website** — static `index.html`, Cloudflare Workers (`red-persimmon.redpersimmon.workers.dev`).
- **Dashboard** — static `velour-dashboard.html`, passcode-gated.
- **Backend** — Supabase (Postgres + RLS + Edge Functions). Ref `hydhezpeuhqhcugnpupu`.
- **Email** — Make.com.
- Salon ID `a0000000-0000-0000-0000-000000000001` · Tech IDs `b0000000-…-0001`…`-0010`.
- **Demo Salon ID `d0000000-0000-0000-0000-000000000001`** — isolated sandbox salon (cloned config from Red Persimmon: technicians, services, hours). Safe to wipe/reseed anytime; used for all testing so real client data is never touched.
- Secrets in Supabase only (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_PASSCODE`). Anon key in site is public/safe.

---

## 3. Repo layout (`velour-platform`)

```
website/index.html
dashboard/velour-dashboard.html
edge-functions/  aivy-chat.ts  owner-aivy.ts  dashboard-read.ts  dashboard-write.ts
sql/  aivy-foundation-1-4.sql  noprefs-fix.sql  (+ older velour-*.sql migrations)
docs/ARCHITECTURE.md
```
Edge Functions & SQL run live in Supabase; repo files are the source-of-truth copies. Edit here **and** deploy/run in Supabase.

---

## 4. Canonical models (never diverge)

- **Revenue — Expected vs. Actual (see §7 for full schema/RPC detail):**
  - **Expected** = `bookings.total_price` — the estimate captured at booking time, never overwritten at checkout. This is what a still-`confirmed` booking always reports.
  - **Actual** = `payments.amount` — the real charged amount, captured only at checkout. Always excludes tip (tip is the technician's money, not the salon's).
  - **Effective value per booking** (what Today/Week/Insights/Customers/Owner-Aivy all read as `a.total`): the real payment if one exists, else the estimate. A completed booking's number upgrades to the true figure the moment it's checked out; bookings completed before checkout existed correctly fall back to their estimate instead of reporting $0.
  - **Payroll / commission / technician-performance source of truth** = `payment_line_items` (per-service, per-technician), **not** `payments`. `payments` is just the transaction header.
  - Customer tags' "spend" (below) uses this same effective value, not a separate calculation.
- **Dates:** today/week/month computed in salon-local time (America/New_York), Monday-start, with previous-window comparisons for trend deltas. **Correction:** this logic is currently implemented **client-side** in the dashboard's briefing builder (`buildBriefing()` in `velour-dashboard.html`) — `aivy_period_range()`, referenced in earlier notes as a DB function, **does not exist in the live database.**
- **Customer tags:** VIP = spend ≥ $300 OR ≥6 visits; Lapsed = ≥1 visit & >8 weeks; Regular = ≥2 active; New = 0–1. ("Spend" = sum of each completed booking's effective value, per the Revenue rule above.)
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work.

---

## 5. Database (key tables)

`salons`, `salon_hours` (day_of_week/open_time/close_time/is_open) · `technicians` (available_days[], active), `technician_services` (287), `technician_links` (locked read-only tokens) · `services` (duration_minutes, price, price_from, category, active) · `customers`, `bookings` (booking_date + start/end_time, status, total_price, total_duration, manage_token, created_by), `booking_services` (also used to pre-fill Checkout line items) · `payments` (checkout transaction header — see §7) · `payment_line_items` (per-service/technician record; payroll/commission source of truth — see §7) · `technician_time_off` (partial/all-day + salon closures) · `email_logs`.

---

## 6. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns least-busy tech who works that day, isn't off, has no clash, and is **qualified for every booked service**; refuses if none.
- Customer emails via Make; token Manage page (`?manage=`); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week (open-slot gaps), Insights, Customers (segments+tags+sort), Technicians (time off, closures, copy/reset schedule links), **Aivy** (auto-briefing + chat; `owner-aivy` function deployed, still shallow — see backlog).
- **Admin Booking** ("+ Add booking" in dashboard): one generic flow for walk-in/phone/manual entry via `create_booking`'s `p_source`/`p_customer_id` — confirmation email auto-skipped for walk-ins, existing/new customer tabs (CRM continuity for repeat walk-ins via `p_customer_id`), service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline + server-side email/phone validation.
- **Checkout & Payments**: full multi-line checkout (service/technician/price/tip per line, multiple technicians per visit) replacing the old direct "Done" action. Expected vs Actual revenue split live throughout Today/Week/Insights/Customers/Owner-Aivy. Full architecture in **§7**.
- **Demo Salon** sandbox for all testing (see §2) — Red Persimmon's real data is never touched by development work.
- **Production cleanup completed:** Red Persimmon's test bookings/customers/technician_time_off wiped; schema, catalog, technicians, hours, and qualifications preserved; verified production-clean.
- Security: RLS locked; passcode/token gating; no secrets in site.
- Website polish: booking-flow states (loading/empty/error/success + availability-error fix), Aivy hero rebalanced, accordion animations, consistent "Book Appointment" wording.
- Data-readiness audit **done**: DB services/durations/prices, technician days/ids, salon_hours, technician_services all **match** hardcoded site values. No seeding needed.

---

## 7. Checkout & Payments Architecture

### Core model: Expected vs. Actual Revenue

- **Expected Revenue** = `bookings.total_price` — the estimate captured at booking time. Never overwritten at checkout. Used for any booking still `confirmed`.
- **Actual Revenue** = `payments.amount` — the real charged amount, captured only at checkout. Excludes tip always (tip is the technician's money, not the salon's).
- **Effective value per booking** (what Today/Week/Insights/Customers/Owner-Aivy all read): the real payment amount if one exists, otherwise the estimate. This means a completed booking's number *upgrades* to the true figure the moment it's checked out, and legacy bookings (completed before this feature existed) correctly fall back to their original estimate rather than reporting $0.
- **Payroll/commission/technician performance source of truth** = `payment_line_items`, not `payments`. `payments` is a transaction header; the line items are the actual per-technician, per-service record.

### Database schema

**`payments`** — one row per checkout transaction (header):

| column | type | notes |
|---|---|---|
| id | uuid, PK | |
| salon_id | uuid, NOT NULL, FK→salons | |
| booking_id | uuid, nullable, FK→bookings | nullable for future no-booking sales |
| customer_id | uuid, nullable, FK→customers | denormalized — future POS/walk-up sales may have no booking, but still need a customer identity |
| amount | numeric, NOT NULL | = Total Charged − Discount, across all lines. Salon revenue. Excludes tip. |
| discount_amount | numeric, NOT NULL, default 0 | header-level only (a whole-visit discount, not per-service) |
| tip_amount | numeric, NOT NULL, default 0 | = sum of line tips. Tracked, never counted as revenue. |
| payment_method | text, NOT NULL | `cash` \| `card` \| `other` |
| source | text, NOT NULL, default `'manual'` | `manual` \| `pos` — future POS integration writes `source='pos'` rows here, no schema change needed |
| notes | text, nullable | |
| created_by | text, nullable | free-text staff name (no per-staff login yet) |
| created_at | timestamptz, default now() | |

**`payment_line_items`** — one row per service actually performed (the payroll/commission/performance source of truth):

| column | type | notes |
|---|---|---|
| id | uuid, PK | |
| payment_id | uuid, NOT NULL, FK→payments | |
| salon_id | uuid, NOT NULL, FK→salons | denormalized for direct reporting queries (avoids joining through payments for every technician/date-range report) |
| booking_id | uuid, nullable, FK→bookings | |
| service_id | uuid, nullable, FK→services | nullable — an ad-hoc line may not match the catalog |
| service_name | text, NOT NULL | **snapshot**, same pattern as `booking_services.service_name` — a future rename/deletion never rewrites history |
| technician_id | uuid, **NOT NULL**, FK→technicians | required — payroll is fundamentally per-technician |
| technician_name | text, NOT NULL | **snapshot**, for the same historical-accuracy reason |
| charged_price | numeric, NOT NULL, ≥0 | |
| tip_amount | numeric, NOT NULL, default 0, ≥0 | |
| voided_at / voided_by / void_reason | timestamptz / text / text, nullable | lightweight audit trail — a correction voids the wrong line (never deletes/overwrites) and inserts a new one |
| corrected_from_id | uuid, nullable, self-FK | links a correction back to the line it replaces |
| created_at | timestamptz, default now() | |

Indexes: `payment_line_items(payment_id)`, `(technician_id, created_at)`, `(salon_id, created_at)`, `(booking_id)`.

**Explicitly deferred** (not built — architecture supports adding these additively, without redesign, when there's real demand): split/multi-tender payments, deposits, refunds/voids at the *payment* level, gift cards, packages/memberships. None of these required speculative columns today.

**Known gap, not yet fixed:** `mark_booking_status`'s cancellation-notify path calls `velour_notify(...)` outside any exception guard — a notify failure would roll back the whole cancellation. Pre-existing behavior, not introduced by this work, not yet addressed.

### RPCs (all `security definer`, `search_path=public`)

**`create_booking(p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start, p_end, p_duration, p_price, p_notes, p_services, p_source default 'website', p_customer_id default null, p_created_by default null)`**
Single entry point for both the public website and the dashboard's Admin Booking flow (`source`: `website` \| `walk_in` \| `phone` \| `manual`). Validates and normalizes email (lowercase/trim, regex-checked) and phone (digits-only, 10-digit, strips leading `1`) — both stay optional, but must be well-formed if present. Raises `INVALID_EMAIL` / `INVALID_PHONE` / `MISSING_FIELDS` / `INVALID_TIME_RANGE` / `SLOT_TAKEN` / `NO_TECH_AVAILABLE`.

**`checkout_booking(p_booking, p_lines jsonb, p_payment_method, p_discount default 0, p_notes default null, p_created_by default null)`**
`p_lines` = `[{service_id, service_name, technician_id, charged_price, tip_amount}, ...]`. Validates every line (technician required and must belong to the same salon; service, if given, must belong to the same salon; price/tip ≥0) before writing anything. Computes header totals from the lines, inserts the `payments` row (with `customer_id` pulled from the booking), inserts one `payment_line_items` row per line, then calls `mark_booking_status(..., 'completed', ...)` — reuses that existing, tested transition rather than duplicating it. Only valid from a `confirmed` booking. Raises `BOOKING_NOT_FOUND` / `INVALID_STATUS_FOR_CHECKOUT` / `NO_SERVICE_LINES` / `PAYMENT_METHOD_REQUIRED` / `INVALID_PAYMENT_METHOD` / `LINE_MISSING_TECHNICIAN` / `INVALID_TECHNICIAN` / `INVALID_SERVICE` / `INVALID_LINE_AMOUNT` / `INVALID_LINE_TIP` / `INVALID_DISCOUNT` / `DISCOUNT_EXCEEDS_CHARGE`.

**`mark_booking_status(p_booking, p_status, p_reason default null, p_by default 'salon')`**
Unchanged interface. Internally: when transitioning to/from `completed`, uses `sum(payments.amount)` for that booking as the customer's `total_spent` delta if a payment exists, falling back to `bookings.total_price` if not (so pre-checkout-era completions still report correctly). Still fires the cancellation webhook via `velour_notify` on `cancelled` (see known gap above).

### Edge Functions

**`dashboard-read`** — `ALLOWED` table set now includes `payments` and `technician_services` (in addition to the original set). Simple passcode-gated read proxy, unchanged otherwise.

**`dashboard-write`** — `ACTIONS` map includes `create_booking: "create_booking"` and `checkout: "checkout_booking"`. This function is a generic `{action, args}` → RPC proxy; it required no changes when `checkout_booking`'s signature changed from a flat amount to `p_lines`, since it just forwards whatever `args` it's given.

### Dashboard (`velour-dashboard.html`)

- **`loadAll()`** now also fetches `payments` and `technician_services`, and persists the raw `booking_services` rows per booking to `store.bookingServices` (used to pre-fill Checkout). The assemble step computes one `total` per booking — actual payment amount if one exists, else the estimate — and this single value is what every revenue consumer in the file reads (Today, Week, Insights, Customer spend/VIP tagging, Owner-Aivy's briefing). Confirmed via full-file audit: `total_price` is referenced exactly once (inside the assemble step); every revenue sum in the file reads `a.total`, nothing else.
- **Admin Booking modal** ("+ Add booking") — generic booking-source flow (walk-in/phone/manual), existing/new customer tabs, service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline email/phone validation mirroring the server rule.
- **Checkout modal** (replaces the old single-amount version and the direct "Done" action) — multi-line, one row per service actually performed: free-text service name with catalog autocomplete (`<datalist>`), technician dropdown (any active technician, not just those on the original booking), charged price, tip, add/remove lines (minimum one, enforced client-side to match the backend). Pre-fills from the booking's actual `booking_services`, technician defaulted to who was scheduled — every field fully editable, lines addable for unscheduled work. Live-computed Total Charged / Discount / Total Tips / Final Payment. Payment method (Cash/Card/Other) has no default — a real choice is required, not assumed. Per-line validation highlights the specific bad row and names the specific problem before submission. Sticky header/footer, scrollable body (same `nb-card` pattern as Admin Booking, for visual/interaction consistency).

### What's still open (not part of this work)

- `v_booking_facts` / `aivy_period_range()` — **do not exist in the live database**, despite earlier notes listing them as built. Owner-Aivy's real implementation doesn't depend on them (it uses a client-side briefing builder from `store.assembled`), so nothing is broken, but any assumption that these exist should be treated as false until someone actually builds them.
- Public website booking form (`index.html`) does not yet have matching inline email/phone validation — the server-side rule protects the data either way, but the website customer only sees a generic error, not an inline one. Agreed fast-follow, not done.
- `technicians.commission_rate` (or equivalent) does not exist — commission calculation itself is not implemented, only the line-item foundation it would read from.
- Payment line item correction/void UI does not exist — the schema (`voided_at`/`voided_by`/`void_reason`/`corrected_from_id`) is ready, but nothing has needed correcting yet.
- Split payments, deposits, refunds/voids, gift cards, packages/memberships — deliberately deferred, additive when needed.

---

## 8. PRIORITIES (current)

**Launch blockers → then Kristy goes live:**

1. ~~Diagnose & fix duplicate bookings~~ — **DONE.** Traced the full fetch→render pipeline and cross-checked the live data; it was 100% test/dev data (one heavily-reused test customer), not a rendering or storage bug. Wiped.
2. ~~Walk-in entry in dashboard~~ — **DONE.** Generalized beyond just "walk-in" into a single Admin Booking flow supporting walk-in/phone/manual sources (see §6/§7).
3. **Security: rate-limit `aivy-chat`; booking spam protection (Turnstile).** Still open — `aivy-chat` has **zero rate limiting today**: it's a public, unauthenticated endpoint calling the Anthropic API directly on the salon's key, which is real, unbounded financial exposure. This is now the **only remaining Critical launch blocker.** Turnstile/booking-spam protection is real but lower-severity (worst case is junk data, not cost) — Recommended, not Critical; safe to do in the first week or two post-launch.
4. ~~Test-data cleanup~~ — **DONE.** Red Persimmon's test customers/bookings/booking_services/technician_time_off wiped; schema, catalog, technicians, hours, and qualifications preserved; verified production-clean.
5. **Browser-validate the full Checkout/Payments flow end-to-end**, on real UI, with real clicks — create a booking, check it out with more than one technician on the visit, confirm Today/Insights/Owner-Aivy reflect Actual Revenue correctly. The backend is fully tested via direct RPC calls against the Demo Salon; the dashboard click-through itself hasn't been run yet.
6. **GO LIVE** — real-world test with Kristy, blocked only on #3 and #5 above.

**Fast follows (after live, guided by real usage):**

7. Finish **Owner-Aivy** (tool-calling on foundations: revenue_summary/day_schedule/rebooking → customer tools → reports/documents). **Note:** earlier notes assumed the DB foundations (`v_booking_facts`, `aivy_period_range()`) already existed to build tool-calling on top of — they don't (see §4/§7). Owner-Aivy today works entirely from a client-side briefing builder. Building real tool-calling means either building those DB foundations for real, or deliberately continuing to extend the client-side approach — a decision to make consciously, not an assumption to inherit.
8. **Time-in / flexible scheduling** (shift-swaps, covering) — folds into shared-availability work. Decision: covered shifts should be **bookable online** (one availability truth), not manual-only. Model = weekly default (available_days) + exceptions both directions (time-off you have; add time-in).
9. **Website Phase 1** — DB-driven catalog (`loadCatalog()` fills existing JS objects from DB, hardcoded fallback; audit done). Unlocks live-editable schedules/hours.
10. **Website inline email/phone validation** — the server-side rule already protects the data (`create_booking` validates regardless of caller); website customers currently only see a generic error, not an inline one like the dashboard now has.
11. **Change-password** setting in dashboard (small).
12. **Payment line item correction/void UI** — schema is ready (see §7), no UI built yet since nothing has needed correcting.
13. **Technician commission/payroll calculation** (rate + report) — `payment_line_items` is the ready data source (see §7); no `commission_rate` column or report UI exists yet.

**Parked (post-first-results / need Kristy content / multi-salon):**

14. De-static website (gallery, reviews, editable content = Website Phase 2); Reputation Engine (review requests first, scoped); multi-tenant hardening; custom domain (fixes email spam); optional re-engagement email, full tech logins.
15. Split/multi-tender payments, deposits, refunds/voids, gift cards, packages/memberships — the Checkout/Payments architecture supports all of these additively without redesign (see §7); build only when a real salon actually needs one.

---

## 9. Ideas backlog (capture, don't lose)

- **Reputation Engine** (Google reviews): start with automated review *request* tied to email flow; later analytics, AI response drafts, feedback insights, reputation dashboard, before/after gallery, growth metrics. Validate demand in owner interviews first. Seductive over-build — keep scoped.
- **Owner interviews:** talk to 15–20 independent nail salon owners before big new builds — validate what they'll pay for.
- **Repeatable onboarding:** templatize services/tech/hours/branding/deploy so salon #2 takes a day, not weeks (can be a manual checklist first).
- **Pricing:** validate a real SaaS price; charge Red Persimmon or a friendly salon (money = only unfaked signal).
- **Usage instrumentation:** once live, track booking completion, Aivy questions, tab usage, no-show rate — let behavior guide the roadmap.
- **Non-hardcoded schedule:** move fully to weekly-default + exceptions so scheduling is data-driven (multi-tenant friendly; next salon = config).
- **Lean one-page Blueprint** now; full founder Blueprint only after 3–5 paying salons.

---

## 10. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. When founder is stressed, give the single next step, not the whole list. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling. One chat = one task (saves usage, sharpens output); update this doc after milestones.

**Claude's tool access, for any new chat:** direct read/write access to the Supabase database (migrations, RPC testing and verification, data cleanup) — proven out extensively across the Checkout/Payments work, always tested on the Demo Salon before touching Red Persimmon. **No** direct access to the local dashboard file or to Supabase's Edge Function deploy pipeline. The working pattern for those two: founder uploads the current file(s) → Claude edits and returns complete replacement file(s), never partial diffs to paste in by hand → founder does the physical deploy (dashboard: replace the local file; Edge Functions: paste into Supabase's browser editor, click Deploy).
