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
- **Planned second secret:** `PAYROLL_PASSCODE` — not yet created. See §11 (Owner Settings & Salon Management roadmap).

---

## 3. Repo layout (`velour-platform`)

```
website/index.html
dashboard/velour-dashboard.html
edge-functions/  aivy-chat.ts  owner-aivy.ts  dashboard-read.ts  dashboard-write.ts
sql/  aivy-foundation-1-4.sql  noprefs-fix.sql  payroll-foundation.sql  (+ older velour-*.sql migrations)
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
- **Dates:** today/week/month computed in salon-local time (America/New_York), Monday-start, with previous-window comparisons for trend deltas. **Correction:** this logic is currently implemented **client-side** in the dashboard's briefing builder (`buildBriefing()` in `velour-dashboard.html`) — `aivy_period_range()`, referenced in earlier notes as a DB function, **does not exist in the live database.**
- **Customer tags:** VIP = spend ≥ $300 OR ≥6 visits; Lapsed = ≥1 visit & >8 weeks; Regular = ≥2 active; New = 0–1. ("Spend" = sum of each completed booking's effective value, per the Revenue rule above.)
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work.

---

## 5. Database (key tables)

`salons`, `salon_hours` (day_of_week/open_time/close_time/is_open) · `technicians` (available_days[], active), `technician_services` (287), `technician_links` (locked read-only tokens) · `services` (duration_minutes, price, price_from, category, active) · `customers`, `bookings` (booking_date + start/end_time, status, total_price, total_duration, manage_token, created_by), `booking_services` (also used to pre-fill Checkout line items) · `payments` (checkout transaction header — see §7) · `payment_line_items` (per-service/technician record; payroll/commission source of truth — see §7) · `technician_time_off` (partial/all-day + salon closures) · `email_logs`.

**Payroll tables (new, see §8 for full schema):** `technician_compensation` (effective-dated pay plans) · `payroll_periods` (owner-defined date ranges, open/closed) · `payroll_period_hours` (manual hours entry for hourly/hybrid techs) · `payroll_period_totals` (frozen per-technician totals, written only at close).

---

## 6. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns least-busy tech who works that day, isn't off, has no clash, and is **qualified for every booked service**; refuses if none.
- Customer emails via Make; token Manage page (`?manage=`); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week (open-slot gaps), Insights, Customers (segments+tags+sort), Technicians (time off, closures, copy/reset schedule links), **Payroll** (compensation setup, periods, preview, close — see §8), **Aivy** (auto-briefing + chat; `owner-aivy` function deployed, still shallow — see backlog).
- **Admin Booking** ("+ Add booking" in dashboard): one generic flow for walk-in/phone/manual entry via `create_booking`'s `p_source`/`p_customer_id` — confirmation email auto-skipped for walk-ins, existing/new customer tabs (CRM continuity for repeat walk-ins via `p_customer_id`), service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline + server-side email/phone validation.
- **Checkout & Payments**: full multi-line checkout (service/technician/price/tip per line, multiple technicians per visit) replacing the old direct "Done" action. Expected vs Actual revenue split live throughout Today/Week/Insights/Customers/Owner-Aivy. Full architecture in **§7**.
- **Payroll**: compensation setup (commission/hourly/hourly+commission, effective-dated), owner-defined payroll periods, live preview with per-technician warnings, close-and-freeze. Full architecture in **§8**.
- **Demo Salon** sandbox for all testing (see §2) — Red Persimmon's real data is never touched by development work.
- **Production cleanup completed:** Red Persimmon's test bookings/customers/technician_time_off wiped; schema, catalog, technicians, hours, and qualifications preserved; verified production-clean.
- Security: RLS locked on most tables; passcode/token gating; no secrets in site. **Known gap:** `payments` and `payment_line_items` still have RLS **disabled** (see §7) — pre-existing, not yet fixed.
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

**Known security gap, not yet fixed:** `payments` and `payment_line_items` have Row Level Security **disabled** — fully exposed to the anon key. Every other sensitive table (`bookings`, `customers`, `technician_compensation`, `payroll_*`) has RLS **enabled with no public policies**, so it's reachable only via the service-role Edge Functions. These two tables are the exception, and it's a real gap — not fixed yet because doing so blind could break the existing dashboard read/write flow. Needs a deliberate pass.

### RPCs (all `security definer`, `search_path=public`)

**`create_booking(p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start, p_end, p_duration, p_price, p_notes, p_services, p_source default 'website', p_customer_id default null, p_created_by default null)`**
Single entry point for both the public website and the dashboard's Admin Booking flow (`source`: `website` \| `walk_in` \| `phone` \| `manual`). Validates and normalizes email (lowercase/trim, regex-checked) and phone (digits-only, 10-digit, strips leading `1`) — both stay optional, but must be well-formed if present. Raises `INVALID_EMAIL` / `INVALID_PHONE` / `MISSING_FIELDS` / `INVALID_TIME_RANGE` / `SLOT_TAKEN` / `NO_TECH_AVAILABLE`.

**`checkout_booking(p_booking, p_lines jsonb, p_payment_method, p_discount default 0, p_notes default null, p_created_by default null)`**
`p_lines` = `[{service_id, service_name, technician_id, charged_price, tip_amount}, ...]`. Validates every line (technician required and must belong to the same salon; service, if given, must belong to the same salon; price/tip ≥0) before writing anything. Computes header totals from the lines, inserts the `payments` row (with `customer_id` pulled from the booking), inserts one `payment_line_items` row per line, then calls `mark_booking_status(..., 'completed', ...)` — reuses that existing, tested transition rather than duplicating it. Only valid from a `confirmed` booking. Raises `BOOKING_NOT_FOUND` / `INVALID_STATUS_FOR_CHECKOUT` / `NO_SERVICE_LINES` / `PAYMENT_METHOD_REQUIRED` / `INVALID_PAYMENT_METHOD` / `LINE_MISSING_TECHNICIAN` / `INVALID_TECHNICIAN` / `INVALID_SERVICE` / `INVALID_LINE_AMOUNT` / `INVALID_LINE_TIP` / `INVALID_DISCOUNT` / `DISCOUNT_EXCEEDS_CHARGE`.

**`mark_booking_status(p_booking, p_status, p_reason default null, p_by default 'salon')`**
Unchanged interface. Internally: when transitioning to/from `completed`, uses `sum(payments.amount)` for that booking as the customer's `total_spent` delta if a payment exists, falling back to `bookings.total_price` if not (so pre-checkout-era completions still report correctly). Still fires the cancellation webhook via `velour_notify` on `cancelled` (see known gap above).

### Edge Functions

**`dashboard-read`** — `ALLOWED` table set: `customers`, `bookings`, `booking_services`, `technicians`, `services`, `technician_time_off`, `salon_hours`, `technician_links`, `technician_services`, `payments`, plus the four payroll tables added in §8. Simple passcode-gated read proxy.

**`dashboard-write`** — `ACTIONS` map includes `create_booking: "create_booking"` and `checkout: "checkout_booking"`, plus the five payroll actions added in §8. This function is a generic `{action, args}` → RPC proxy; it required no changes when `checkout_booking`'s signature changed from a flat amount to `p_lines`, since it just forwards whatever `args` it's given. Same pattern extended cleanly for payroll.

### Dashboard (`velour-dashboard.html`)

- **`loadAll()`** fetches `payments` and `technician_services`, and persists the raw `booking_services` rows per booking to `store.bookingServices` (used to pre-fill Checkout). The assemble step computes one `total` per booking — actual payment amount if one exists, else the estimate — and this single value is what every revenue consumer in the file reads (Today, Week, Insights, Customer spend/VIP tagging, Owner-Aivy's briefing). Confirmed via full-file audit: `total_price` is referenced exactly once (inside the assemble step); every revenue sum in the file reads `a.total`, nothing else. `loadAll()` also now fetches `technician_compensation` and `payroll_periods` (see §8) — this is loaded for every dashboard user today, which is the reason the Payroll module currently has **no real access control** (see §8's security note and §11's roadmap item).
- **Admin Booking modal** ("+ Add booking") — generic booking-source flow (walk-in/phone/manual), existing/new customer tabs, service chip grid, all active technicians shown with informational (non-blocking) availability notes, inline email/phone validation mirroring the server rule.
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
- **No real access control on the Payroll *view* yet.** `loadAll()` fetches `technician_compensation` and `payroll_periods` for every dashboard user at boot, before any tab is opened — meaning anyone who knows the single shared `DASHBOARD_PASSCODE` (receptionists, potentially technicians) already has compensation and payroll data sitting in browser memory, regardless of whether a UI lock exists on the Payroll tab itself. A client-side-only PIN on the tab would be security theater, not real protection, since the data is already loaded. Real protection requires a second, **server-verified** secret (a `PAYROLL_PASSCODE` checked inside `dashboard-read`/`dashboard-write` before returning payroll data or running payroll RPCs) and `loadAll()` no longer preloading payroll data by default. This was consciously scoped out of Payroll and moved to **Owner Settings & Salon Management** (§11) rather than bolted on here, since it's really a dashboard-wide access-control feature, not a Payroll-specific one.

### Testing approach

- **All RPCs tested directly against Demo Salon** via real transactions (real `payments`/`payment_line_items` rows, real compensation history including a mid-period rate change, a voided line, a technician with no compensation record) — verified by hand against the expected math, not just "it ran without erroring." All test data cleaned up afterward; Red Persimmon's production data was never touched at any point.
- Two real bugs were caught and fixed this way before the RPCs were considered done: a PL/pgSQL column-ambiguity error (function output-parameter names colliding with CTE column names inside `calculate_payroll_preview`), and the `tech_ids` CTE alias mismatch. Both were only findable by actually running the SQL against real data, not by reading it.
- **Dashboard JS verified two ways:** static checks (syntax, no duplicate element IDs, balanced tags, every `onclick`/`onchange` handler resolves to a real function), and a functional pass using a real DOM (`jsdom`) fed the *actual* JSON captured from the live RPC tests — confirmed correct labels, correct sort order, correct warning-triggered lockout of the close button, and correct dollar figures, plus a direct simulation reproducing and then disproving the stuck-save bug.
- **Not yet done:** an actual browser click-through on Demo Salon. Claude's tooling in this environment can reach Supabase directly (queries, migrations, Edge Function deploys) but cannot reach Supabase's HTTPS endpoints from its sandboxed network, and has no way to render the local dashboard file in a real browser. Everything above is real verification, but it is not a substitute for one live pass — the same gap that existed for Checkout/Payments before go-live (§7, priority #5), now also true of Payroll. Recommended before Kristy uses either.

---

## 9. PRIORITIES (current)

**Launch blockers → then Kristy goes live:**

1. ~~Diagnose & fix duplicate bookings~~ — **DONE.**
2. ~~Walk-in entry in dashboard~~ — **DONE.**
3. **Security: rate-limit `aivy-chat`; booking spam protection (Turnstile).** Still open — `aivy-chat` has **zero rate limiting today**: it's a public, unauthenticated endpoint calling the Anthropic API directly on the salon's key, which is real, unbounded financial exposure. This remains the **only remaining Critical launch blocker.** Turnstile/booking-spam protection is real but lower-severity (worst case is junk data, not cost) — Recommended, not Critical; safe to do in the first week or two post-launch.
4. ~~Test-data cleanup~~ — **DONE.**
5. **Browser-validate the full Checkout/Payments flow end-to-end**, on real UI, with real clicks — create a booking, check it out with more than one technician on the visit, confirm Today/Insights/Owner-Aivy reflect Actual Revenue correctly. The backend is fully tested via direct RPC calls against the Demo Salon; the dashboard click-through itself hasn't been run yet.
6. **Browser-validate the full Payroll flow end-to-end** (new) — set up compensation, run a period, enter hours, close it, view history, on real UI with real clicks. Same gap as #5, same reason (see §8 testing approach).
7. **GO LIVE** — real-world test with Kristy, blocked only on #3, #5, and #6 above.

**Fast follows (after live, guided by real usage):**

8. Finish **Owner-Aivy** (tool-calling on foundations: revenue_summary/day_schedule/rebooking → customer tools → reports/documents). **Note:** earlier notes assumed the DB foundations (`v_booking_facts`, `aivy_period_range()`) already existed to build tool-calling on top of — they don't (see §4/§7). Owner-Aivy today works entirely from a client-side briefing builder. Building real tool-calling means either building those DB foundations for real, or deliberately continuing to extend the client-side approach — a decision to make consciously, not an assumption to inherit. Payroll data (`payroll_period_totals`) is now a ready, canonical source Owner-Aivy could read from once tool-calling exists.
9. **Time-in / flexible scheduling** (shift-swaps, covering) — folds into shared-availability work. Decision: covered shifts should be **bookable online** (one availability truth), not manual-only. Model = weekly default (available_days) + exceptions both directions (time-off you have; add time-in).
10. **Website Phase 1** — DB-driven catalog (`loadCatalog()` fills existing JS objects from DB, hardcoded fallback; audit done). Unlocks live-editable schedules/hours. Superseded in scope by the fuller "database-driven website" goal in §11 — revisit together when that module is designed.
11. **Website inline email/phone validation** — the server-side rule already protects the data (`create_booking` validates regardless of caller); website customers currently only see a generic error, not an inline one like the dashboard now has.
12. **Payment line item correction/void UI** — schema is ready (see §7), no UI built yet since nothing has needed correcting.
13. ~~Technician commission/payroll calculation~~ — **DONE.** See §8.

**Moved to the Owner Settings & Salon Management roadmap (§11), no longer tracked here:** change-password / owner PIN management, technician add/edit/deactivate/archive.

**Parked (post-first-results / need Kristy content / multi-salon):**

14. De-static website (gallery, reviews, editable content = Website Phase 2); Reputation Engine (review requests first, scoped); multi-tenant hardening; custom domain (fixes email spam); optional re-engagement email, full tech logins.
15. Split/multi-tender payments, deposits, refunds/voids, gift cards, packages/memberships — the Checkout/Payments architecture supports all of these additively without redesign (see §7); build only when a real salon actually needs one.

---

## 10. Ideas backlog (capture, don't lose)

- **Reputation Engine** (Google reviews): start with automated review *request* tied to email flow; later analytics, AI response drafts, feedback insights, reputation dashboard, before/after gallery, growth metrics. Validate demand in owner interviews first. Seductive over-build — keep scoped.
- **Owner interviews:** talk to 15–20 independent nail salon owners before big new builds — validate what they'll pay for.
- **Repeatable onboarding:** templatize services/tech/hours/branding/deploy so salon #2 takes a day, not weeks (can be a manual checklist first).
- **Pricing:** validate a real SaaS price; charge Red Persimmon or a friendly salon (money = only unfaked signal).
- **Usage instrumentation:** once live, track booking completion, Aivy questions, tab usage, no-show rate — let behavior guide the roadmap.
- **Non-hardcoded schedule:** move fully to weekly-default + exceptions so scheduling is data-driven (multi-tenant friendly; next salon = config).
- **Lean one-page Blueprint** now; full founder Blueprint only after 3–5 paying salons.

---

## 11. Roadmap (next planned module) — Owner Settings & Salon Management

**Status: roadmap only. Not designed, not implemented.** Deliberately kept out of the Payroll work — this is a distinct module in its own right, and deserves its own dedicated design session (product + engineering) rather than being bolted onto whatever chat happened to surface the need. Captured here so the direction is clear whenever that session happens.

Planned responsibilities:

- **Dashboard password management** — today there is exactly one shared `DASHBOARD_PASSCODE`, checked client-side and re-verified server-side per request, with **no way for the owner to change it** without editing the Supabase secret directly. Needs an in-dashboard settings flow.
- **Owner Payroll PIN** — a second, owner-only secret gating the Payroll tab and compensation data specifically, so receptionists and technicians (who may know the general dashboard passcode) can never see salary, commission, or hourly-rate information. Must be verified **server-side** inside `dashboard-read`/`dashboard-write` — a client-side-only PIN would be false security, since `loadAll()` currently pulls payroll data into browser memory for every user regardless of which tab they open (see §8's security note). Implementing this properly likely also means `loadAll()` no longer preloads payroll tables by default, loading them only after the PIN is verified.
- **Technician lifecycle management** — add, edit, deactivate, and archive technicians without hardcoding them and without ever deleting historical bookings, payroll, or reports tied to a technician who's no longer active. `technicians.active` already exists; the missing piece is a real owner-facing flow plus a clear, deliberate policy for what "archived" means for historical joins (should already be safe, given `payment_line_items`/`booking_services` snapshot names rather than living off a foreign key alone — but this needs to be confirmed explicitly, not assumed, when the module is actually designed).
- **Service management** — add/edit/deactivate services, prices, durations, categories from the dashboard instead of direct DB edits.
- **Business settings** — hours, closures, and other salon-level configuration currently requiring direct database or Supabase UI access.
- **Database-driven website synchronization** — the long-term goal that changes made in the dashboard (technicians, services, hours, prices) automatically reflect on the public website with no code change or redeploy. Website Phase 1 (§9, item 10) is a partial, narrower first step already scoped (DB-driven catalog only); this module's version is the fuller version covering all salon configuration, and should absorb/supersede that item when designed.
- **Future owner/security settings** — whatever else surfaces once the above exists (e.g., audit log of who changed what, session/device management, per-technician login if that's ever pursued).

---

## 12. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. When founder is stressed, give the single next step, not the whole list. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling. One chat = one task (saves usage, sharpens output); update this doc after milestones.

**Claude's tool access, for any new chat:** direct read/write access to the Supabase database (migrations, RPC testing and verification, data cleanup, Edge Function deploys) — proven out extensively across both the Checkout/Payments and Payroll work, always tested on the Demo Salon before touching Red Persimmon. **No** direct network access to Supabase's HTTPS endpoints from the sandboxed environment (migrations/RPCs go through dedicated tools instead, which do work), and no way to render the local dashboard file in a real browser. The working pattern for the dashboard file: founder uploads the current file → Claude edits and returns one complete replacement file, never partial diffs to paste in by hand → founder does the physical deploy (dashboard: replace the local file; Edge Functions: Claude can deploy these directly via tooling now, confirmed working during Payroll).

**Established testing pattern for dashboard JS changes (new, from Payroll):** static checks (syntax via `node --check`, duplicate-ID scan, tag-balance scan, every `onclick`/`onchange` handler resolves to a real function) plus a functional pass using `jsdom` fed real data captured from actual RPC tests — catches real rendering bugs (sort order, conditional logic, stuck button states) without needing a live browser. Not a full substitute for one real click-through before a feature touches Kristy, but a meaningfully higher bar than "the code looks right."
