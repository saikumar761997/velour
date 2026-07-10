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

- **Website** — static `index.html`, Cloudflare Workers (`red-persimmon.redpersimmon.workers.dev`). Calls Supabase **directly** with the anon key via a generic `dbGet()`/`dbRpc()` helper — no Edge Function proxy on this side, protected by permissive public RLS policies on `salons`, `services`, `technicians`, `salon_hours` (see §9).
- **Dashboard** — static `velour-dashboard.html`, per-salon passcode-gated (see §9 — no longer a single shared global passcode).
- **Backend** — Supabase (Postgres + RLS + Edge Functions). Ref `hydhezpeuhqhcugnpupu`.
- **Email** — Make.com.
- Salon ID `a0000000-0000-0000-0000-000000000001` · Tech IDs `b0000000-…-0001`…`-0010`.
- **Demo Salon ID `d0000000-0000-0000-0000-000000000001`** — isolated sandbox salon (cloned config from Red Persimmon: technicians, services, hours). Safe to wipe/reseed anytime; used for all testing so real client data is never touched.
- Secrets in Supabase only (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`). Anon key in site is public/safe.
- ~~Planned second secret: `PAYROLL_PASSCODE`~~ — **superseded.** Passcodes and the Payroll PIN are no longer environment-variable secrets at all; they're per-salon hashed values in the new `salon_settings` table, changeable by the owner in-dashboard. See §9.
- **`DASHBOARD_PASSCODE` env var still exists** as a **temporary legacy fallback only**, used solely when a request arrives without a `salon_id` (see §9). Not a live secret going forward — scheduled for removal once both salons are confirmed stable on the new per-salon path.

---

## 3. Repo layout (`velour-platform`)

```
website/index.html
dashboard/velour-dashboard.html
edge-functions/  aivy-chat.ts  owner-aivy.ts  dashboard-read.ts  dashboard-write.ts
sql/  aivy-foundation-1-4.sql  noprefs-fix.sql  payroll-foundation.sql  owner-settings-foundation.sql  (+ older velour-*.sql migrations)
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
- **Payroll — Live vs. Frozen (see §8 for full schema/RPC detail):**
  - **Live** = `calculate_payroll_preview()` — always computed fresh from `payment_line_items` + `technician_compensation` for an **open** period. Reflects corrections/voids immediately.
  - **Frozen** = `payroll_period_totals` — written once, only at `close_payroll_period()`. A closed period's numbers never change again, even if a correction lands on a date inside that period afterward. This is the deliberate guarantee: paid history stays paid history.
  - **Compensation history is effective-dated, never overwritten.** A rate change closes the prior `technician_compensation` row (`effective_end_date`) and opens a new one. Commission on a given service line always uses whichever row was effective on that line's actual date — so a mid-period raise splits correctly instead of applying one flat rate to the whole period.
  - Tips are always shown separately from gross pay — they're the technician's money already, not a salon payroll obligation.
- **Business Hours — Weekly Default vs. Enforcement (see §9 for full schema/RPC detail):**
  - **`salon_hours`** is the single source of truth for normal weekly operating hours — one row per day of week, `is_open`/`open_time`/`close_time`.
  - **Salon closures** are date-specific exceptions (a holiday, an early day) layered on top of the weekly default, not a separate hours system.
  - **Enforcement is asymmetric by design:** customer self-booking (website) is hard-blocked from violating hours/closures; staff-entered bookings (walk-in/phone/manual) and dashboard reschedules are only ever warned, never blocked — the owner is always allowed to make a conscious exception.
  - Enforcement is **per-salon feature-flagged** (`salon_settings.enforce_business_hours`), not universal the moment the code ships — see §9's rollout pattern.
- **Dates:** today/week/month computed in salon-local time (America/New_York), Monday-start, with previous-window comparisons for trend deltas. **Correction:** this logic is currently implemented **client-side** in the dashboard's briefing builder (`buildBriefing()` in `velour-dashboard.html`) — `aivy_period_range()`, referenced in earlier notes as a DB function, **does not exist in the live database.** **All "get today's date" computations in the dashboard now use a single shared `localDateStr()` helper** (local calendar-date components, not `toISOString()`) — see §9's cross-cutting fix note; `toISOString().slice(0,10)`-style date computation should never be reintroduced anywhere in this file, since it silently rolls to the next day in the evening for any timezone behind UTC.
- **Customer tags:** VIP = spend ≥ $300 OR ≥6 visits; Lapsed = ≥1 visit & >8 weeks; Regular = ≥2 active; New = 0–1. ("Spend" = sum of each completed booking's effective value, per the Revenue rule above.)
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work.
- **Lifecycle model (established in §9, to be reused for any future "manage-able entity"):** `active` (boolean) = temporary/reversible deactivation; `archived_at` (nullable timestamp) = permanent, and requires the record already be inactive first. Rows are **never deleted**. Archiving is blocked server-side if future confirmed bookings reference the record; no bulk-reassignment tooling — the owner resolves conflicts via existing reschedule/cancel tools first.

---

## 5. Database (key tables)

`salons` (now includes `maps_url`) · `salon_settings` (**new** — per-salon `dashboard_passcode_hash`, `payroll_passcode_hash`, `enforce_business_hours`; see §9) · `salon_hours` (day_of_week/open_time/close_time/is_open) · `technicians` (available_days[], active), `technician_services` (287), `technician_links` (locked read-only tokens) · `services` (duration_minutes, price, price_from, category, active) · `customers`, `bookings` (booking_date + start/end_time, status, total_price, total_duration, manage_token, created_by), `booking_services` (also used to pre-fill Checkout line items) · `payments` (checkout transaction header — see §7) · `payment_line_items` (per-service/technician record; payroll/commission source of truth — see §7) · `technician_time_off` (partial/all-day + salon closures) · `email_logs`.

**Payroll tables (see §8 for full schema):** `technician_compensation` (effective-dated pay plans) · `payroll_periods` (owner-defined date ranges, open/closed) · `payroll_period_hours` (manual hours entry for hourly/hybrid techs) · `payroll_period_totals` (frozen per-technician totals, written only at close).

---

## 6. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns least-busy tech who works that day, isn't off, has no clash, and is **qualified for every booked service**; refuses if none.
- Customer emails via Make; token Manage page (`?manage=`); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week (open-slot gaps), Insights, Customers (segments+tags+sort), Technicians (individual time off, copy/reset schedule links — salon-wide closures moved to Settings, see §9), **Payroll** (compensation setup, periods, preview, close — see §8), **Settings** (Access & Security, Business Information, Business Hours — see §9; Services/Staff/Website still to come), **Aivy** (auto-briefing + chat; `owner-aivy` function deployed, still shallow — see backlog).
- **Admin Booking** ("+ Add booking" in dashboard): one generic flow for walk-in/phone/manual entry via `create_booking`'s `p_source`/`p_customer_id` — confirmation email auto-skipped for walk-ins, existing/new customer tabs (CRM continuity for repeat walk-ins via `p_customer_id`), service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline + server-side email/phone validation, plus a non-blocking outside-business-hours warning (see §9).
- **Checkout & Payments**: full multi-line checkout (service/technician/price/tip per line, multiple technicians per visit) replacing the old direct "Done" action. Expected vs Actual revenue split live throughout Today/Week/Insights/Customers/Owner-Aivy. Full architecture in **§7**.
- **Payroll**: compensation setup (commission/hourly/hourly+commission, effective-dated), owner-defined payroll periods, live preview with per-technician warnings, close-and-freeze, **now with real server-side access control via the Payroll PIN** (see §9 — the gap noted in earlier versions of this doc is resolved). Full architecture in **§8**.
- **Owner Settings** — per-salon authentication, Payroll PIN enforcement, Business Information (live-synced to both dashboard and website), and Business Hours (dashboard CRUD + closures + server-side enforcement for website bookings). Full architecture in **§9**.
- **Demo Salon** sandbox for all testing (see §2) — Red Persimmon's real data is never touched by development work.
- **Production cleanup completed:** Red Persimmon's test bookings/customers/technician_time_off wiped; schema, catalog, technicians, hours, and qualifications preserved; verified production-clean.
- Security: RLS locked on most tables; per-salon passcode/PIN/token gating; no secrets in site. **Known gap:** `payments` and `payment_line_items` still have RLS **disabled** (see §7) — pre-existing, not yet fixed.
- Website polish: booking-flow states (loading/empty/error/success + availability-error fix), Aivy hero rebalanced, accordion animations, consistent "Book Appointment" wording. Business Information (name/phone/email/address/maps link) now live-synced from the database (see §9); Services/Staff/Hours slot-generation remain hardcoded pending the consolidated Website Integration pass (see §9).
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

**Known security gap, not yet fixed:** `payments` and `payment_line_items` have Row Level Security **disabled** — fully exposed to the anon key. Every other sensitive table (`bookings`, `customers`, `technician_compensation`, `payroll_*`, `salon_settings`) has RLS **enabled with no public policies**, so it's reachable only via the service-role Edge Functions. These two tables are the exception, and it's a real gap — not fixed yet because doing so blind could break the existing dashboard read/write flow. Needs a deliberate pass.

### RPCs (all `security definer`, `search_path=public`)

**`create_booking(p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start, p_end, p_duration, p_price, p_notes, p_services, p_source default 'website', p_customer_id default null, p_created_by default null)`**
Single entry point for both the public website and the dashboard's Admin Booking flow (`source`: `website` \| `walk_in` \| `phone` \| `manual`). Validates and normalizes email (lowercase/trim, regex-checked) and phone (digits-only, 10-digit, strips leading `1`) — both stay optional, but must be well-formed if present. Raises `INVALID_EMAIL` / `INVALID_PHONE` / `MISSING_FIELDS` / `INVALID_TIME_RANGE` / `SLOT_TAKEN` / `NO_TECH_AVAILABLE`. **As of §9, also enforces business hours/closures for `p_source='website'` when the salon's feature flag is on** — see §9 for the full rule; raises `SALON_CLOSED` / `OUTSIDE_BUSINESS_HOURS` in that case. No other logic in this function was altered by that change.

**`checkout_booking(p_booking, p_lines jsonb, p_payment_method, p_discount default 0, p_notes default null, p_created_by default null)`**
`p_lines` = `[{service_id, service_name, technician_id, charged_price, tip_amount}, ...]`. Validates every line (technician required and must belong to the same salon; service, if given, must belong to the same salon; price/tip ≥0) before writing anything. Computes header totals from the lines, inserts the `payments` row (with `customer_id` pulled from the booking), inserts one `payment_line_items` row per line, then calls `mark_booking_status(..., 'completed', ...)` — reuses that existing, tested transition rather than duplicating it. Only valid from a `confirmed` booking. Raises `BOOKING_NOT_FOUND` / `INVALID_STATUS_FOR_CHECKOUT` / `NO_SERVICE_LINES` / `PAYMENT_METHOD_REQUIRED` / `INVALID_PAYMENT_METHOD` / `LINE_MISSING_TECHNICIAN` / `INVALID_TECHNICIAN` / `INVALID_SERVICE` / `INVALID_LINE_AMOUNT` / `INVALID_LINE_TIP` / `INVALID_DISCOUNT` / `DISCOUNT_EXCEEDS_CHARGE`.

**`mark_booking_status(p_booking, p_status, p_reason default null, p_by default 'salon')`**
Unchanged interface. Internally: when transitioning to/from `completed`, uses `sum(payments.amount)` for that booking as the customer's `total_spent` delta if a payment exists, falling back to `bookings.total_price` if not (so pre-checkout-era completions still report correctly). Still fires the cancellation webhook via `velour_notify` on `cancelled` (see known gap above).

### Edge Functions

**`dashboard-read`** — `ALLOWED` table set: `customers`, `bookings`, `booking_services`, `technicians`, `services`, `technician_time_off`, `salon_hours`, `technician_links`, `technician_services`, `payments`, `salons`, plus the four payroll tables added in §8. Per-salon passcode-gated read proxy (see §9 for the authentication model — no longer a single shared passcode), with a second Payroll-PIN gate specifically on the four payroll tables.

**`dashboard-write`** — `ACTIONS` map includes `create_booking: "create_booking"` and `checkout: "checkout_booking"`, the five payroll actions added in §8, and the Owner Settings actions added in §9 (`change_passcode`, `set_payroll_pin`, `get_settings_status`, `update_business_info`, `update_business_hours`). This function is a generic `{action, args}` → RPC proxy; it required no changes when `checkout_booking`'s signature changed from a flat amount to `p_lines`, since it just forwards whatever `args` it's given. Same pattern extended cleanly for payroll and for Owner Settings.

### Dashboard (`velour-dashboard.html`)

- **`loadAll()`** fetches `payments`, `technician_services`, and `salons` (see §9), and persists the raw `booking_services` rows per booking to `store.bookingServices` (used to pre-fill Checkout). The assemble step computes one `total` per booking — actual payment amount if one exists, else the estimate — and this single value is what every revenue consumer in the file reads (Today, Week, Insights, Customer spend/VIP tagging, Owner-Aivy's briefing). Confirmed via full-file audit: `total_price` is referenced exactly once (inside the assemble step); every revenue sum in the file reads `a.total`, nothing else. **`loadAll()` deliberately does *not* fetch `technician_compensation`/`payroll_periods` at boot** — those now load only after Payroll PIN verification (see §9; this reverses what earlier versions of this doc described, and resolves the access-control gap noted in §8).
- **Admin Booking modal** ("+ Add booking") — generic booking-source flow (walk-in/phone/manual), existing/new customer tabs, service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline email/phone validation mirroring the server rule, plus a non-blocking outside-business-hours warning shared with the Reschedule modal (see §9).
- **Checkout modal** (replaces the old single-amount version and the direct "Done" action) — multi-line, one row per service actually performed: free-text service name with catalog autocomplete (`<datalist>`), technician dropdown (any active technician, not just those on the original booking), charged price, tip, add/remove lines (minimum one, enforced client-side to match the backend). Pre-fills from the booking's actual `booking_services`, technician defaulted to who was scheduled — every field fully editable, lines addable for unscheduled work. Live-computed Total Charged / Discount / Total Tips / Final Payment. Payment method (Cash/Card/Other) has no default — a real choice is required, not assumed. Per-line validation highlights the specific bad row and names the specific problem before submission. Sticky header/footer, scrollable body (same `nb-card` pattern as Admin Booking, for visual/interaction consistency).

### What's still open (not part of this work)

- `v_booking_facts` / `aivy_period_range()` — **do not exist in the live database**, despite earlier notes listing them as built. Owner-Aivy's real implementation doesn't depend on them (it uses a client-side briefing builder from `store.assembled`), so nothing is broken, but any assumption that these exist should be treated as false until someone actually builds them.
- Public website booking form (`index.html`) does not yet have matching inline email/phone validation — the server-side rule protects the data either way, but the website customer only sees a generic error, not an inline one. Agreed fast-follow, not done.
- Payment line item correction/void UI does not exist — the schema (`voided_at`/`voided_by`/`void_reason`/`corrected_from_id`) is ready, but nothing has needed correcting yet.
- Split payments, deposits, refunds/voids, gift cards, packages/memberships — deliberately deferred, additive when needed.

---

## 8. Payroll Architecture — **COMPLETE**

Built to solve a real, named pain point: Kristy was tracking technician work in a paper notebook for payroll. The goal was to turn payroll into a **report generated from data already captured at checkout**, not a second bookkeeping system. It's additive throughout — nothing in §7's Checkout/Payments architecture was redesigned or altered.

### Core model: Live vs. Frozen

- **Live** — while a payroll period is `open`, its numbers are always computed fresh by `calculate_payroll_preview()` from `payment_line_items` + `technician_compensation`. Corrections and voids are reflected immediately.
- **Frozen** — `close_payroll_period()` runs that same computation once and writes the result to `payroll_period_totals`. From then on, that period's numbers are read from the frozen snapshot, never recomputed — so a correction entered next month can never silently change what a technician was already paid for a closed period.
- **Compensation is effective-dated, never overwritten.** Changing a tech's pay closes the previous `technician_compensation` row (`effective_end_date`) and opens a new one in the same transaction. Commission on any given service line is calculated using whichever compensation row was effective **on that line's actual date** — a mid-period raise splits correctly.
- **Tips are informational, not part of gross pay.** They're the technician's money already; payroll shows them per row but never folds them into what the salon owes.

### Database schema

**`technician_compensation`** — effective-dated pay plan history, one row per plan period per technician:

| column | notes |
|---|---|
| technician_id, salon_id | FK, required |
| comp_type | `commission` \| `hourly` \| `hourly_plus_commission` \| `salary` (salary allowed by schema, not yet used by any UI or calculation) |
| commission_rate | nullable; required when `comp_type` includes commission |
| hourly_rate | nullable; required when `comp_type` includes hourly |
| salary_amount | nullable; reserved for future use |
| effective_start_date | required |
| effective_end_date | nullable — null means "current" |
| created_by, created_at | |

Constraint enforces the right fields are populated for the chosen `comp_type`. No overlap-prevention constraint at the DB level yet — enforced by the single writer RPC (`set_technician_compensation`) instead; flagged as a conscious choice, not an oversight, revisit if a second write path is ever added.

**`payroll_periods`** — one row per owner-defined pay period:

| column | notes |
|---|---|
| salon_id, label, notes | `label` and `notes` added per Sai's request — human-readable identification, e.g. "Week 27 – July 7 to July 13" |
| period_start, period_end | owner picks custom dates each time — no forced cadence |
| status | `open` \| `closed` |
| closed_at, closed_by, payroll_version | `payroll_version` reserved for future calculation-method changes |

**`payroll_period_hours`** — manual hours entry, one row per technician per period (`unique(payroll_period_id, technician_id)`), only meaningful for `hourly`/`hourly_plus_commission` techs.

**`payroll_period_totals`** — the frozen snapshot, one row per technician per closed period: `service_revenue`, `commission_earned`, `hours_worked`, `hourly_earned`, `tips_total`, `gross_pay`, `services_performed`, `customers_served`. Written only by `close_payroll_period()`.

All four tables: RLS **enabled**, no public policies — reachable only through the service-role Edge Functions, matching the `bookings`/`customers` pattern (not the `payments` gap noted in §7).

### RPCs (all `security definer`, `search_path=public`)

Each does exactly one job, per explicit design requirement — no single giant payroll function:

**`set_technician_compensation(p_salon_id, p_technician_id, p_comp_type, p_effective_start_date, p_commission_rate, p_hourly_rate, p_salary_amount, p_created_by)`**
Closes the technician's current open-ended comp row (if any) and inserts a new one. Raises `EFFECTIVE_DATE_NOT_AFTER_CURRENT` if the new date isn't strictly after the current row's start — prevents backdating over an active plan. Raises `MISSING_COMMISSION_RATE` / `MISSING_HOURLY_RATE` / `MISSING_RATE_FOR_HYBRID` / `MISSING_SALARY_AMOUNT` / `INVALID_COMP_TYPE` / `TECHNICIAN_NOT_FOUND`.

**`create_payroll_period(p_salon_id, p_label, p_period_start, p_period_end, p_notes, p_created_by)`**
Blocks overlapping date ranges for the same salon (`PERIOD_OVERLAPS_EXISTING`). Raises `INVALID_PERIOD_RANGE` if end precedes start.

**`update_payroll_hours(p_payroll_period_id, p_technician_id, p_hours_worked, p_entered_by)`**
Upserts hours for a technician within a period. Raises `PERIOD_CLOSED` if the period is no longer open, `PERIOD_NOT_FOUND`, `TECHNICIAN_NOT_IN_SALON`, `INVALID_HOURS`.

**`calculate_payroll_preview(p_payroll_period_id)`** — returns `TABLE(technician_id, technician_name, comp_type, service_revenue, commission_earned, hours_worked, hourly_rate_used, hourly_earned, tips_total, gross_pay, services_performed, customers_served, warnings text[])`.
Never writes anything. For each technician, sums non-voided `payment_line_items` in the period's date range; commission on each line is computed using whichever `technician_compensation` row was effective on that line's date (handles mid-period rate changes correctly). `customers_served` is a **distinct** count via join to `payments.customer_id` — added as an additive column after initial build, at Sai's request, specifically to distinguish "customers served" from "services performed" (one visit can include multiple services for the same customer). Surfaces `warnings` per technician instead of silently guessing:
  - missing compensation record for some or all of a technician's lines in the period
  - hourly rate changed mid-period (uses the most recent rate; owner is told rather than left to assume)
  - no compensation record at all for the technician

**`close_payroll_period(p_payroll_period_id, p_closed_by, p_payroll_version default '1')`**
Calls `calculate_payroll_preview()` internally; **raises `UNRESOLVED_WARNINGS_BLOCK_CLOSE` if any technician still has a warning** — a bad number can never get locked into frozen history. Otherwise writes one `payroll_period_totals` row per technician and marks the period `closed`. Raises `PERIOD_NOT_FOUND` / `PERIOD_ALREADY_CLOSED`.

**Planned, not built:** `reopen_payroll_period()` — deliberately deferred; a closed period should require an explicit, audited reopen action, not a silent recompute.

### Edge Functions (extended, additive)

- **`dashboard-read`** `ALLOWED` set gained `technician_compensation`, `payroll_periods`, `payroll_period_hours`, `payroll_period_totals`.
- **`dashboard-write`** `ACTIONS` map gained: `set_compensation → set_technician_compensation`, `create_payroll_period → create_payroll_period`, `update_payroll_hours → update_payroll_hours`, `preview_payroll → calculate_payroll_preview`, `close_payroll_period → close_payroll_period`. `calculate_payroll_preview` is a read-only, table-returning function but is called through `dashboard-write` (not `dashboard-read`) since it's an RPC call, not a plain table select — same mechanism already used for every other RPC action.

Both changes are whitelist-only; zero logic changes to either function's existing behavior.

### Dashboard (`velour-dashboard.html`) — Payroll tab

**Design principle, explicit requirement:** the dashboard performs **zero** payroll math. Every number rendered comes directly from `calculate_payroll_preview` or `payroll_period_totals`; the dashboard only displays data and submits actions. This matters beyond Payroll — it means Owner-Aivy, future reports, exports, and any future mobile app can all read the same canonical numbers without re-deriving them.

**Layout, single page (not a wizard):**
1. **Compensation strip** — collapsed by default, always (a technician's pay rate is set once and rarely revisited). Shows a plain count, "*N of M technicians configured*" (+ "· action needed" if any aren't), with an explicit **Edit Compensation** button to expand. Editing opens a small popup: three plain buttons (Commission / Hourly / Both), the relevant rate field(s), an effective-start date.
2. **Period card** — "+ Start payroll period" if none open; otherwise label, dates, notes, an hours-entry block (only rendered if at least one technician's comp type includes hourly), and the live preview table.
3. **Preview table** — one row per technician: services performed, revenue, commission, hours, hourly pay, tips (labeled "theirs," not part of what's owed), **gross pay** bold. A warning icon with a plain-language tooltip sits inline on any affected row. **No separate analytics summary cards** (top earner / most revenue / most customers) — that content would duplicate Insights; Payroll stays scoped to compensation, calculation, and closing. Close button is disabled with a plain reason (`"Fix the warnings above before closing"`) whenever any warning exists.
4. **History** — closed periods below, click one for its frozen per-technician breakdown.

**Known bug found and fixed during this build (worth remembering as a pattern):** the Save buttons on the compensation and new-period modals were disabled during the request but never re-enabled on the success path — only the error branch reset them. Since these are static, persistent modal DOM nodes (not re-rendered from a template each time), a successful save left the button permanently disabled and reading "Saving…"; the *next* time that modal opened, clicking Save did nothing at all (no request, no error — just silence), which looked exactly like the dashboard being stuck, and only a full page refresh cleared it. The existing, correct convention elsewhere in this file (`openCheckout()`, `openTimeOff()`) already resets the Save button's disabled/text state every time the modal **opens**, not only on error — the Payroll modals had simply missed that line. Fixed by adding the reset to both the `open*` and `close*` functions for both modals. **Any future modal in this file should follow the same convention: reset the submit button's state on open (and, defensively, on close), not just in the catch block.**

### Security decisions

- All four payroll tables: RLS enabled, no public policies, reachable only via the service-role Edge Functions — consistent with `bookings`/`customers`, not the `payments` RLS gap noted in §7.
- ~~No real access control on the Payroll *view* yet.~~ **Resolved — see §9.** The Payroll PIN now gates all four payroll tables and all five payroll write actions server-side, and `loadAll()` no longer preloads payroll data by default. The architecture and migration behavior are documented in full in §9; this section is left describing the calculation/freezing model only.

### Testing approach

- **All RPCs tested directly against Demo Salon** via real transactions (real `payments`/`payment_line_items` rows, real compensation history including a mid-period rate change, a voided line, a technician with no compensation record) — verified by hand against the expected math, not just "it ran without erroring." All test data cleaned up afterward; Red Persimmon's production data was never touched at any point.
- Two real bugs were caught and fixed this way before the RPCs were considered done: a PL/pgSQL column-ambiguity error (function output-parameter names colliding with CTE column names inside `calculate_payroll_preview`), and the `tech_ids` CTE alias mismatch. Both were only findable by actually running the SQL against real data, not by reading it.
- **Dashboard JS verified two ways:** static checks (syntax, no duplicate element IDs, balanced tags, every `onclick`/`onchange` handler resolves to a real function), and a functional pass using a real DOM (`jsdom`) fed the *actual* JSON captured from the live RPC tests — confirmed correct labels, correct sort order, correct warning-triggered lockout of the close button, and correct dollar figures, plus a direct simulation reproducing and then disproving the stuck-save bug.
- **This same jsdom-simulation technique was reused successfully in §9** to definitively rule out a suspected client-side bug in the Business Hours save flow (simulated a real user edit via an actual DOM `change` event, confirmed the payload sent was correct) — establishing it as the standard way to investigate "is this a client bug or a data/server issue" questions without needing a live browser.

---

## 9. Owner Settings & Salon Management Architecture

**Status: Access & Security, Business Information, and Business Hours are COMPLETE and live-tested on Demo. Services, Staff, and Website (sync-status panel) are not yet built — see "Remaining roadmap for this module" below.**

This module replaces what was previously a roadmap-only placeholder in this doc. It gives the owner a permanent, in-dashboard control center instead of requiring direct Supabase access for salon configuration, and establishes the patterns (feature-flag rollout, lifecycle model, website-sync approach) that the rest of the platform should follow going forward.

### Settings navigation (final shape)

A permanent, top-level dashboard nav item, with a single-row sub-tab strip (horizontal scroll as the overflow safety valve, not wrapping):

```
Settings
 ├─ Access & Security    (dashboard password, Payroll PIN)
 ├─ Business Information (name, phone, email, address, maps_url)
 ├─ Business Hours       (weekly hours, salon closures, conflict warning)
 ├─ Services             (not yet built — add/edit/deactivate/archive)
 ├─ Staff                (not yet built — absorbs the old Technicians tab's time-off/schedule-links/qualifications, plus add/edit/deactivate/archive)
 └─ Website              (not yet built — sync status panel only)
```

Each section is a self-contained render function registered in one flat dispatch table (`SETTINGS_SECTIONS`) — adding a future section is one new entry, no shell changes. A flat (non-nested) tab strip is deliberate at this scale; revisit only if sections grow well past ten.

**"Staff" is a deliberate rename from "Technicians"** — UI label only, no schema change. The `technicians` table and all related columns remain named as-is; a schema rename would be premature abstraction for roles (receptionist, manager) that don't exist yet.

**Salon closures already moved** out of the old Technicians tab into Business Hours (no backend change — `close_salon_day`/`reopen_salon_day` reused as-is) — rationale: closures are a "when is the salon open" concern, not a "who is working" concern. Individual technician time-off and schedule links remain in the (soon to be renamed) Staff section.

No new RBAC/permissions model — Settings sits behind the same single dashboard passcode as everything else. Two specific actions (passcode change, PIN change) additionally require the current credential at the moment of that action, not a separate page-level gate.

### Per-salon authentication architecture

Dashboard authentication moved from a single global `DASHBOARD_PASSCODE` environment variable (shared across all salons) to a per-salon model:

- **`salon_settings` table** — one row per salon: `salon_id` (PK/FK), `dashboard_passcode_hash`, `payroll_passcode_hash` (nullable), `enforce_business_hours` (boolean, default `false`), `updated_at`. All passcode/PIN values stored as bcrypt hashes (`pgcrypto`, `extensions.crypt()`/`extensions.gen_salt('bf')`) — **pgcrypto lives in the `extensions` schema in this Supabase project, not `public`**; functions referencing it must schema-qualify (`extensions.crypt(...)`), a real and easy-to-miss gotcha.
- **`verify_dashboard_passcode(p_salon_id, p_passcode)`** — `security definer`, restricted to `service_role`. Returns boolean.
- **`change_dashboard_passcode(p_salon_id, p_current_passcode, p_new_passcode)`** — requires correct current value; minimum 4 characters.
- Both `dashboard-read` and `dashboard-write` require `salon_id` in every request body alongside `passcode`, and verify via the RPC above rather than comparing against an env var.
- **Legacy fallback:** if a request arrives without `salon_id`, both functions fall back to comparing against the original `DASHBOARD_PASSCODE` env var. This is TODO-marked in both function source files and is a **temporary migration path only** — remove once every dashboard copy (Demo and Red Persimmon) is confirmed sending `salon_id` on every request and has had a real-world soak period. **Status: Red Persimmon is in that soak period now; not yet removed.**
- Client-side: `CONFIG.SALON_ID` (already present for booking-flow purposes) is now also sent on every `dashboard-read`/`dashboard-write` call, added centrally in the two shared helper functions (`api.get()`, the generic write helper) — not per call site.
- **A real incident during rollout, worth remembering:** the initial migration seeded Red Persimmon's passcode hash from a documented placeholder value rather than the actual live secret, causing a 100%-failure lockout the moment the new code deployed (caught before any real customer traffic hit it, rolled back immediately). **Root cause was a bad data assumption, not a code defect** — never seed a credential hash from documentation; always derive it from a value confirmed live at the moment of seeding.

### Payroll PIN architecture

- **`verify_payroll_pin(p_salon_id, p_pin)`** — `security definer`, `service_role` only. Returns `true` if no PIN has ever been set for that salon (nothing to protect yet — matches the pre-existing unprotected state), or if the given PIN matches the stored hash. Returns `false` for a wrong PIN once one is set, or for an unknown salon. **A near-incident during rollout:** the first version of this function returned `false` whenever no PIN was set, which would have locked Red Persimmon's live dashboard out of Payroll entirely the moment enforcement deployed, since Kristy had never been prompted to set one up. Caught via log inspection before any real traffic hit it; fixed before it mattered. The lesson generalizes: **new enforcement must always explicitly account for salons that haven't opted in yet**, not just for correct/incorrect credentials.
- **`set_payroll_pin(p_salon_id, p_current_pin, p_new_pin)`** — `p_current_pin` may be null only for first-time setup (no existing hash). Minimum 4 characters.
- **Server-side enforcement (the real protection, not just a UI prompt):** `dashboard-read` gates four tables — `technician_compensation`, `payroll_periods`, `payroll_period_hours`, `payroll_period_totals` — behind `verify_payroll_pin`. `dashboard-write` gates five actions — `set_compensation`, `create_payroll_period`, `update_payroll_hours`, `preview_payroll`, `close_payroll_period` — the same way. `change_passcode`, `set_payroll_pin`, and `get_settings_status` are explicitly excluded from this gate (they self-verify or reveal no payroll data).
- **Client-side:** `loadAll()` no longer preloads the four payroll tables at boot. Opening the Payroll tab checks a session-scoped `payrollPinVerified` flag; if unverified, shows an inline PIN prompt that calls the existing `reloadPayrollLookups()` (its silent per-fetch error-swallowing was removed so a wrong PIN actually surfaces as a failure). Once verified, the PIN travels alongside the passcode on every subsequent request for the rest of the session (`window.__VELOUR_PAYROLL_PIN`), and is only cleared on Lock or a fresh login — never re-prompted on every tab switch. Setting/changing the PIN from Settings auto-verifies the session (no immediate re-prompt after just entering it).

**Migration behavior (intentional, documented so it never reads as a security hole):** Payroll access is unprotected by default for any salon that hasn't configured a PIN — this is the pre-existing state every salon starts in, not a bypass introduced by this work. The moment an owner sets a PIN, enforcement becomes mandatory for that salon. **Follow-up needed:** once a real onboarding flow exists for salon #2+, new salons should be walked through Payroll PIN setup as part of onboarding, or prompted on first Payroll access, rather than relying on the owner to discover Settings unprompted.

### Business Information architecture

- **Schema:** `salons` already held `name`, `phone`, `email`, `address`, `address2`, `city`, `state`, `zip` — only `maps_url` (text, nullable) was added.
- **`update_salon_info(p_salon_id, p_name, p_phone, p_email, p_address, p_address2, p_city, p_state, p_zip, p_maps_url)`** — `p_name` required; phone/email reuse `create_booking`'s exact normalization (10-digit phone, standard email regex) and are optional; `maps_url` requires `http(s)://` if provided.
- `salons` added to `dashboard-read`'s allowlist (passcode-gated like everything else there — no Payroll PIN involved, unrelated to payroll).
- **Dashboard:** sidebar salon name is dynamic via `loadAll()`'s existing fetch pattern, falls back to hardcoded text on any miss.
- **Website — live-synced immediately, not deferred to the consolidated Website Integration pass:** hero location line, both "Find Us" blocks, footer (name/address/phone/email), the announcement bar phone number, and the embedded Google Map all read from `salons` via the website's **pre-existing** architecture — direct `dbGet()` calls using the anon key, protected by **already-existing permissive public RLS policies** (`qual: true`) on `salons`/`services`/`technicians`/`salon_hours`. This is a materially different, already-established pattern from the dashboard's passcode-gated Edge Function proxy, and was deliberately reused rather than introducing a new `website-read` Edge Function (an earlier proposal, corrected once the existing RLS-based pattern was actually verified).
- The map embed is rebuilt from structured address fields using Google's no-API-key `output=embed` URL trick — **not** derived from the freeform `maps_url` field, which can't be reliably transformed for every URL shape an owner might paste in. Known, accepted limitation: a highly specific custom `maps_url` pin could theoretically differ slightly from the address-geocoded embed.
- Every synced element falls back to its original hardcoded content if the fetch fails or a given field is empty — never blanks out, never blocks page render.
- **Deliberately out of scope, tracked as technical debt:** `<title>`/meta tags, FAQ content, testimonials/review links, Aivy's `SYSTEM_PROMPT`, and hardcoded phone numbers inside booking-error-handling JS strings. These belong to a future Website Content/Aivy phase.
- Placeholder database values (e.g. a test email) are expected and left as-is until real client onboarding populates the actual business email/phone — not something to reconcile mid-build.

### Business Hours architecture

Three independent layers, each fully tested before the next was built — the general pattern (small, isolated, sequential verification) is the template for any future change of comparable risk:

**Layer 1 — Dashboard.**
- **`update_salon_hours(p_salon_id, p_hours jsonb)`** — takes all 7 days at once, all-or-nothing (validates every day before writing any), requires `close_time > open_time` for any day marked open.
- Non-blocking conflict warning: recalculates live as the owner edits hours (before saving), comparing against already-loaded future confirmed bookings — no new RPC, no new fetch.

**Layer 2 — Server-side enforcement in `create_booking`, feature-flagged.**
- Gated by `salon_settings.enforce_business_hours` (default `false` for every salon — zero behavior change on deploy).
- Applies **only** when `p_source = 'website'`. Checks, in order: (1) `salon_hours.is_open` for the date's day-of-week — reject `SALON_CLOSED` if false; (2) a date-specific salon closure via `technician_time_off.salon_closure=true` — reject `SALON_CLOSED`; (3) requested start/end falls within that day's open/close window — reject `OUTSIDE_BUSINESS_HOURS` otherwise.
- **Staff-entered bookings (`walk_in`/`phone`/`manual`) and dashboard reschedules are never blocked**, regardless of the flag — the owner is exercising discretion, not a customer self-booking. Instead, a shared, non-blocking client-side function (`outsideBusinessHoursWarning()`) shows an identical warning message in both the Admin Booking modal and the Reschedule modal.
- **Verified end-to-end through the real website flow, not just SQL** — confirmed via direct inspection of the actual network request/response using temporary, clearly-marked console logging in the site's shared `dbRpc()` helper (removed once verification was complete): `400` status, `{"code":"P0001","message":"OUTSIDE_BUSINESS_HOURS"}`. This "temporary instrumented logging, removed after verification" technique is the recommended way to get first-party proof of real client/server behavior without needing a connected browser.
- **Rollout status: flag is `true` on Demo (for continued testing), `false` on Red Persimmon.** Deliberately not enabled for Red Persimmon yet — the decision was made to do one production cutover after the full Owner Settings module is complete, rather than enabling features one at a time.

**Layer 3 — Website slot generation. Not built.** The public site's real slot generator (`bmLoadSlots()`) still reads a hardcoded `SALON_HRS` JS object, entirely disconnected from the `salon_hours` table — discovered during this work, not introduced by it. This is a known, deliberate gap, folded into the consolidated Website Integration strategy below rather than fixed piecemeal.

**Documented, not built — future one-off hours exceptions:** the clean extension point for holiday hours, special event hours, or one-off late openings is a future `salon_hours_exceptions` table (`salon_id, exception_date, open_time, close_time, is_closed, reason`) overriding the weekly default for a single date — consistent with this platform's existing "weekly default + exceptions" model (§10, item 10) already used for technician time-off. Salon closures could eventually be modeled as a special case of this (`is_closed=true`), unifying with the current `technician_time_off`-based mechanism — but that would require migrating existing closure data and is not planned as part of any current work.

### Website integration strategy

**Decision: one consolidated Website Integration pass, not section-by-section.** Business Information was made live on the website immediately because the change was small (a handful of display fields). Business Hours enforcement (Layer 2) was made live immediately because it's a security/correctness concern independent of display. But full catalog-level website sync (Services, Staff, remaining Hours display) is being deliberately deferred as one consolidated phase, done once the dashboard is completely established as the authoritative source across every Owner Settings section — not converted piecemeal. This fully supersedes the narrower "Website Phase 1 — DB-driven catalog" item previously tracked in the Priorities list (§10) — that item no longer exists as a separate line item; its scope is now owned entirely by this section.

**Established website architecture pattern to reuse for that phase:** the website does **not** use an Edge Function proxy. It calls Supabase directly with the anon key via a generic `dbGet()`/`dbRpc()` helper, protected by permissive public RLS policies already present on `salons`, `services`, `technicians`, and `salon_hours`. Any future website-facing read should follow this same pattern for consistency.

**Known gap for that phase to address:** public RLS on `services`/`technicians` is a blanket `true` — there is no server-enforced `active=true` filter. Whatever currently keeps inactive/archived items off the public site is client-side query filtering only.

**Also confirmed hardcoded, awaiting that same pass:** the entire visible service menu (names, prices, categories) and `SVC_DUR` (a separate hardcoded duration lookup used for real booking-duration math) — a structurally bigger conversion than Business Information or Business Hours, since it means replacing static markup with JS-rendered content, not swapping a few text fields.

### Feature-flag rollout strategy

Established as the standard pattern for any change that is either (a) served by shared, non-salon-scoped infrastructure (an Edge Function or a Postgres function used by every salon at once, with no per-salon deployment mechanism), or (b) touches the live booking pipeline directly:

1. Add a per-salon boolean flag to `salon_settings`, defaulting to the value that preserves **today's exact behavior** for every existing salon.
2. Deploy the updated code. Verify via direct testing that behavior is unchanged while the flag is off, for every salon, before proceeding.
3. Enable the flag for Demo only. Test exhaustively — both the newly-enabled behavior and every exemption/edge case — via direct SQL/RPC calls first, then through the real end-to-end flow (dashboard and/or website).
4. Only after full verification, enable the flag for Red Persimmon as its own deliberate, isolated action — never bundled with other changes.

This pattern was established for `enforce_business_hours` and should be reused for any comparably risky future change.

### Lifecycle model (established here, to be reused for Services and Staff)

`active` (boolean) = temporary/reversible deactivation; `archived_at` (nullable timestamp) = permanent, and requires the record already be inactive first. Rows are **never deleted**. Archiving is blocked server-side if future confirmed bookings reference the record; no bulk-reassignment tooling — the owner resolves conflicts via existing reschedule/cancel tools first. (Also stated in §4 as a canonical model.)

### New RPCs and migrations (this module, to date)

**Migrations:**
- `salon_settings` (new table): `salon_id` PK/FK, `dashboard_passcode_hash`, `payroll_passcode_hash` (nullable), `enforce_business_hours` (boolean, default `false`), `updated_at`.
- `salons.maps_url` (new column, nullable text).

**RPCs (all `security definer`, restricted to `service_role` unless noted):**
- `verify_dashboard_passcode(p_salon_id, p_passcode)` → boolean
- `change_dashboard_passcode(p_salon_id, p_current_passcode, p_new_passcode)` → void
- `verify_payroll_pin(p_salon_id, p_pin)` → boolean (returns `true` if no PIN set yet)
- `set_payroll_pin(p_salon_id, p_current_pin, p_new_pin)` → void
- `get_settings_status(p_salon_id)` → `{payroll_pin_set, updated_at}` (metadata only, never a hash)
- `update_salon_info(p_salon_id, p_name, p_phone, p_email, p_address, p_address2, p_city, p_state, p_zip, p_maps_url)` → void
- `update_salon_hours(p_salon_id, p_hours jsonb)` → void (all 7 days, all-or-nothing)

### Rollout strategy for future salons

- **Existing salons (Demo, Red Persimmon)** default to the pre-migration behavior for every new protection mechanism introduced (Payroll PIN unset = unprotected; `enforce_business_hours` = false) — nothing changes for them until the owner opts in via Settings, or until a deliberate, isolated flag-flip is performed.
- **New salons (once salon #2 exists)** should not silently inherit this "unprotected by default" state indefinitely. Two follow-ups are explicitly needed, not yet built: (1) Payroll PIN setup should be part of new-salon onboarding, or prompted on first Payroll access; (2) new salons should have `enforce_business_hours` seeded to `true` from the start (or prompted during onboarding to confirm their real hours before enabling it), since a brand-new salon has no legacy customer-facing behavior to protect by defaulting to `false`.
- Any future per-salon feature flag should follow the same `salon_settings`-based pattern established here, with the same explicit default-safe-for-existing-salons / default-active-for-new-salons distinction made deliberately, not left implicit.

### Remaining roadmap for this module

- **Services** — add/edit/deactivate/archive, same lifecycle model as above. Archive-blocking must match future bookings **by service name**, not `service_id` — `booking_services.service_id` exists as a column but is not currently populated by `create_booking` (only `service_name` is), consistent with how technician-qualification matching elsewhere already works by name. `price_from` (boolean "From $X" display flag, not a second price) and `reengagement_weeks` (existing column, currently unused anywhere) both need an explicit inclusion decision when this section is designed. Website sync explicitly deferred to the consolidated pass above.
- **Staff** — absorbs the old Technicians tab's time-off/schedule-links/qualifications; add/edit/deactivate/archive. Archived technician's schedule link should auto-invalidate, with a fresh token generated on reactivation. **Known related gap:** `close_salon_day` only inserts time-off rows for technicians active *at the moment of closing* — a technician added or reactivated afterward has no row for that already-closed date, and could theoretically still appear bookable. Relevant once this section's archive/reactivate flow exists; not yet fixed.
- **Website** (Settings tab) — sync status panel only ("last successful check" + manual "Test website sync" button), once the consolidated Website Integration pass exists to actually check against.
- **Final Website Integration pass** — replace the hardcoded service catalog + `SVC_DUR`, the hardcoded `SALON_HRS` slot generator, and any remaining hardcoded technician/business data on the live website with database-driven rendering, using the established `dbGet()`/RLS pattern. Should also resolve the `active=true` server-side filtering gap noted above.
- **Known bug, tracked separately, not blocking:** a stale-state issue in the public website's booking wizard — submitting immediately after clicking "Back" and selecting a different date/time can be rejected once, then succeed on an identical retry. Reproduced twice, unrelated to Business Hours enforcement (proven separately via direct SQL and console inspection) — appears to be internal wizard state (`bm.date`/`bm.slotRaw`/etc.) not fully refreshing between selections. Pick up after Owner Settings is complete unless it starts blocking other work.

---

## 10. PRIORITIES (current)

**Launch blockers → then Kristy goes live:**

1. ~~Diagnose & fix duplicate bookings~~ — **DONE.**
2. ~~Walk-in entry in dashboard~~ — **DONE.**
3. **Security: rate-limit `aivy-chat`; booking spam protection (Turnstile).** Still open — `aivy-chat` has **zero rate limiting today**: it's a public, unauthenticated endpoint calling the Anthropic API directly on the salon's key, which is real, unbounded financial exposure. This remains the **only remaining Critical launch blocker.** Turnstile/booking-spam protection is real but lower-severity (worst case is junk data, not cost) — Recommended, not Critical; safe to do in the first week or two post-launch.
4. ~~Test-data cleanup~~ — **DONE.**
5. **Browser-validate the full Checkout/Payments flow end-to-end**, on real UI, with real clicks — create a booking, check it out with more than one technician on the visit, confirm Today/Insights/Owner-Aivy reflect Actual Revenue correctly. The backend is fully tested via direct RPC calls against the Demo Salon; the dashboard click-through itself hasn't been run yet.
6. **Browser-validate the full Payroll flow end-to-end** (new) — set up compensation, run a period, enter hours, close it, view history, on real UI with real clicks. Same gap as #5, same reason (see §8 testing approach).
7. **Complete Owner Settings** (Services, Staff, Website tab) and do the **single production cutover** for Red Persimmon — enabling per-salon auth's legacy-fallback removal and `enforce_business_hours` together as one deliberate step, per the decision recorded in §9, rather than piecemeal.
8. **GO LIVE** — real-world test with Kristy, blocked only on #3, #5, #6, and #7 above.

**Fast follows (after live, guided by real usage):**

9. Finish **Owner-Aivy** (tool-calling on foundations: revenue_summary/day_schedule/rebooking → customer tools → reports/documents). **Note:** earlier notes assumed the DB foundations (`v_booking_facts`, `aivy_period_range()`) already existed to build tool-calling on top of — they don't (see §4/§7). Owner-Aivy today works entirely from a client-side briefing builder. Building real tool-calling means either building those DB foundations for real, or deliberately continuing to extend the client-side approach — a decision to make consciously, not an assumption to inherit. Payroll data (`payroll_period_totals`) is now a ready, canonical source Owner-Aivy could read from once tool-calling exists.
10. **Time-in / flexible scheduling** (shift-swaps, covering) — folds into shared-availability work. Decision: covered shifts should be **bookable online** (one availability truth), not manual-only. Model = weekly default (available_days) + exceptions both directions (time-off you have; add time-in). **Note:** this exact "weekly default + exceptions" model is now also the basis for the planned `salon_hours_exceptions` design in §9 — the two should be designed together, not independently, when either is picked up.
11. **Website inline email/phone validation** — the server-side rule already protects the data (`create_booking` validates regardless of caller); website customers currently only see a generic error, not an inline one like the dashboard now has.
12. **Payment line item correction/void UI** — schema is ready (see §7), no UI built yet since nothing has needed correcting.
13. ~~Technician commission/payroll calculation~~ — **DONE.** See §8.
14. **Stale booking-wizard state bug** — see §9's "Remaining roadmap for this module."
15. **`payments`/`payment_line_items` RLS gap** — see §7's known security gap, still open.

**Parked (post-first-results / need Kristy content / multi-salon):**

16. De-static website (gallery, reviews, editable content = Website Phase 2 content, distinct from the operational-data Website Integration pass in §9); Reputation Engine (review requests first, scoped); multi-tenant hardening (including the RLS active/inactive filtering gap noted in §9); custom domain (fixes email spam); optional re-engagement email (note: `services.reengagement_weeks` already exists in schema, unused — see §9); full tech logins.
17. Split/multi-tender payments, deposits, refunds/voids, gift cards, packages/memberships — the Checkout/Payments architecture supports all of these additively without redesign (see §7); build only when a real salon actually needs one.

---

## 11. Ideas backlog (capture, don't lose)

- **Reputation Engine** (Google reviews): start with automated review *request* tied to email flow; later analytics, AI response drafts, feedback insights, reputation dashboard, before/after gallery, growth metrics. Validate demand in owner interviews first. Seductive over-build — keep scoped.
- **Owner interviews:** talk to 15–20 independent nail salon owners before big new builds — validate what they'll pay for.
- **Repeatable onboarding:** templatize services/tech/hours/branding/deploy so salon #2 takes a day, not weeks (can be a manual checklist first). **Should explicitly include:** Payroll PIN setup and confirming real business hours before enabling enforcement — see §9's "Rollout strategy for future salons."
- **Pricing:** validate a real SaaS price; charge Red Persimmon or a friendly salon (money = only unfaked signal).
- **Usage instrumentation:** once live, track booking completion, Aivy questions, tab usage, no-show rate — let behavior guide the roadmap.
- **Non-hardcoded schedule:** move fully to weekly-default + exceptions so scheduling is data-driven (multi-tenant friendly; next salon = config). See §9's `salon_hours_exceptions` design sketch.
- **Lean one-page Blueprint** now; full founder Blueprint only after 3–5 paying salons.

---

## 12. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. When founder is stressed, give the single next step, not the whole list. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling. One chat = one task (saves usage, sharpens output); update this doc after milestones.

**Claude's tool access, for any new chat:** direct read/write access to the Supabase database (migrations, RPC testing and verification, data cleanup, Edge Function deploys) — proven out extensively across Checkout/Payments, Payroll, and Owner Settings work, always tested on the Demo Salon before touching Red Persimmon. **No** direct network access to Supabase's HTTPS endpoints from the sandboxed environment (migrations/RPCs go through dedicated tools instead, which do work), and no way to render the local dashboard or website file in a real browser directly. The working pattern for either file: founder uploads the current file → Claude edits and returns one complete replacement file, never partial diffs to paste in by hand → founder does the physical deploy/testing. Edge Functions: Claude can deploy these directly via tooling (confirmed working repeatedly since Payroll).

**Established testing pattern for dashboard/website JS changes:** static checks (syntax via `node --check`, duplicate-ID scan, tag-balance scan, every `onclick`/`onchange` handler resolves to a real function) plus a functional pass using `jsdom` fed real data (either captured from actual RPC tests, or by simulating a real user interaction via actual DOM events like `dispatchEvent(new Event('change'))`) — catches real rendering/logic bugs without needing a live browser, and can also be used to **definitively rule out** a suspected client-side bug by faithfully reproducing the exact user action and inspecting the actual payload produced. Not a full substitute for one real click-through before a feature touches Kristy, but a meaningfully higher bar than "the code looks right."

**For genuinely needing to observe a real browser's actual network traffic (new, from §9):** temporary, clearly-marked `console.log` statements inserted at the single shared request-helper choke point (e.g., a shared `dbRpc()`/`api.get()` function) capture the exact payload and response for *every* call through that path, without needing to instrument each call site individually — removed immediately once verification is complete. **Do not** ask the founder to install third-party browser extensions claiming Claude/AI integration to enable direct browser automation — only the official, Anthropic-provided browsing connection should ever be used for that, and only after explicit confirmation it's the legitimate one.

**Shared, non-salon-scoped infrastructure requires extra care.** Some things in this stack have no per-salon deployment mechanism — a Postgres function (e.g. `create_booking`) or an Edge Function (`dashboard-read`/`dashboard-write`) is the same code for every salon the instant it's deployed; only the *data* it operates on is salon-scoped. "Test on Demo first" for this class of change means verifying correctness via Demo-scoped calls **before** deploying, and/or gating new behavior behind a per-salon feature flag (see §9) — it does not mean the deployment itself can be limited to Demo only. Treat any change to this category of infrastructure with the same scrutiny as a change to the live booking path, because in a very real sense, it is one.
