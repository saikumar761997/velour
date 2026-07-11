# Velour — Salon Management Platform (Source of Truth)

Velour is an **AI-first operating system for independent nail salons**. First live client: **Red Persimmon Nails & Spa** (Manchester, NH; owner Kristy). Long-term goal: a **multi-tenant** platform where each salon is *configuration, not custom code*.

This doc is the product + engineering + business source of truth and the handoff summary for any new chat. **Update it after each milestone.**

**Document status as of this update:** Owner Settings module is now **100% complete** — all six sections (Access & Security, Business Information, Business Hours, Services, Staff, Website) are built and verified at the implementation level. The consolidated Website Integration pass (previously tracked as future work) has also been completed as part of finishing Staff, ahead of the original sequencing, because Staff's technician-hours work made the website's hardcoded data duplication actively harmful (see §9). **What remains before Red Persimmon go-live:** one comprehensive manual/browser end-to-end validation pass on Demo (not yet performed — see §13), then the Red Persimmon production cutover, then the pre-existing launch blockers in §10 (rate limiting, browser-validation of Checkout/Payroll).

---

## 1. Vision & strategy

- **Wedge:** the best AI-powered operating system for independent nail salons — not a feature-for-feature clone of Fresha/GlossGenius.
- **Differentiator:** the complete ecosystem — Website → Booking → CRM → Dashboard → Customer Aivy → Owner Aivy — not just a chatbot. **Aivy is the core brand.**
- **Stage goal:** get the first **5–10 paying salons**. Prove demand and repeatability before scaling features.
- **Feature filter:** every feature must (1) increase salon revenue, (2) reduce owner workload, or (3) improve customer experience. If not, don't build it.
- **Current #1 risk:** "will salons other than Kristy pay?" — unproven. Priority is a real-world test with Red Persimmon, then client #2.

---

## 2. Stack & key IDs

- **Website** — static `index.html` (deliverable file name: `website.html`), Cloudflare Workers (`red-persimmon.redpersimmon.workers.dev`). Calls Supabase **directly** with the anon key via a generic `dbGet()`/`dbRpc()` helper — no Edge Function proxy on this side, protected by permissive public RLS policies on `salons`, `services`, `technicians`, `salon_hours`, and now also `technician_hours`, `technician_services` (see §9). **As of this update, `dbGet()` throws on any failure instead of silently returning `[]`** — see §9's "Website live-data architecture" for the full honest-failure model that replaced the old hardcoded-data approach.
- **Dashboard** — static `velour-dashboard.html` (deliverable file name: `dashboard.html`), per-salon passcode-gated (see §9). **The old standalone "Technicians" nav item/view has been fully removed** — Staff (under Settings) is now the only place technician data is managed (see §9).
- **Backend** — Supabase (Postgres + RLS + Edge Functions). Ref `hydhezpeuhqhcugnpupu`.
- **Email** — Make.com.
- Salon ID `a0000000-0000-0000-0000-000000000001` (Red Persimmon) · Tech IDs `b0000000-…-0001`…`-0010`.
- **Demo Salon ID `d0000000-0000-0000-0000-000000000001`** — isolated sandbox salon (cloned config from Red Persimmon: technicians, services, hours, and now `technician_hours`, backfilled — see §9). Safe to wipe/reseed anytime; used for all testing so real client data is never touched.
- Secrets in Supabase only (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`). Anon key in site is public/safe.
- ~~Planned second secret: `PAYROLL_PASSCODE`~~ — **superseded.** Passcodes and the Payroll PIN are per-salon hashed values in `salon_settings`, changeable by the owner in-dashboard. See §9.
- **`DASHBOARD_PASSCODE` env var still exists** as a **temporary legacy fallback only** (see §9). **Status unchanged this session** — Red Persimmon is still in its soak period; not yet removed. Removal is bundled into the "single production cutover" (see §10).

---

## 3. Repo layout (`velour-platform`)

```
website/index.html            (deliverable: website.html)
dashboard/velour-dashboard.html (deliverable: dashboard.html)
edge-functions/  aivy-chat.ts  owner-aivy.ts  dashboard-read.ts  dashboard-write.ts
sql/  aivy-foundation-1-4.sql  noprefs-fix.sql  payroll-foundation.sql  owner-settings-foundation.sql  services-foundation.sql  staff-foundation.sql  technician-hours-foundation.sql  (+ older velour-*.sql migrations)
docs/ARCHITECTURE.md
```
Edge Functions & SQL run live in Supabase; repo files are the source-of-truth copies. Edit here **and** deploy/run in Supabase. (The `services-foundation.sql`/`staff-foundation.sql`/`technician-hours-foundation.sql` file names are suggested groupings for the migrations described in §9 — apply the same discipline of keeping a repo copy in sync with what's live.)

---

## 4. Canonical models (never diverge)

- **Revenue — Expected vs. Actual (see §7 for full schema/RPC detail):** unchanged this session.
- **Payroll — Live vs. Frozen (see §8):** unchanged this session.
- **Business Hours — Weekly Default vs. Enforcement (see §9):** unchanged this session (Business Hours itself was not touched — only Staff's *technician*-hours model, which is new and separate, described below).
- **Technician Hours — Weekly Default, per-technician (NEW, see §9):** `technician_hours` is now the single source of truth for a technician's working days *and* hours, mirroring `salon_hours`'s exact shape (one row per technician per day of week, `is_available`/`start_time`/`end_time`). `technicians.available_days` (the old text-array column) is **left in place as inert legacy data** — no longer read or written by any code path, kept only because dropping it isn't necessary and carries no benefit yet. Do not reintroduce any code path that reads `available_days` going forward; if you find one, it's a bug.
- **Dates:** unchanged this session — `localDateStr()` remains the only correct way to get "today" in the dashboard; never reintroduce `toISOString().slice(0,10)`-style computation.
- **Customer tags:** unchanged this session.
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work. **This session's single biggest reinforcement of this principle:** the website's entire hardcoded-data layer (`TECH_DB`, `SVC_DUR`, `SALON_HRS`, `WIZARD_DATA`, `TECH_SERVICES`) — which had already drifted from the real database in several places — was replaced with live, salon-scoped reads. See §9.
- **Lifecycle model** (`active` boolean = reversible; `archived_at` = permanent, requires already-inactive; never delete; archive blocked by future confirmed bookings) — reused as-is for both **Services** and **Staff** this session, exactly as planned. No changes to the model itself.

---

## 5. Database (key tables)

`salons` (includes `maps_url`) · `salon_settings` (per-salon `dashboard_passcode_hash`, `payroll_passcode_hash`, `enforce_business_hours`, and **new this session:** `enforce_technician_hours`; see §9) · `salon_hours` (day_of_week/open_time/close_time/is_open) · `technicians` (`available_days[]` — now legacy/inert, see §4; `active`; **new:** `archived_at`) · `technician_services` (qualifications join table, no `salon_id` column of its own — 287 rows for Red Persimmon, 70+ for Demo as of this session, 574 total across both salons before the website's fetch was corrected to scope by technician id rather than an unbounded cross-salon fetch) · **`technician_hours` (NEW TABLE this session — see §9)** · `technician_links` (locked read-only tokens) · `services` (duration_minutes, price, price_from, category, active, **`archived_at`**, `display_order` — backend-only, no reorder UI yet) · `customers`, `bookings` (booking_date + start/end_time, status, total_price, total_duration, manage_token, created_by), `booking_services` · `payments` · `payment_line_items` · `technician_time_off` (partial/all-day + salon closures) · `email_logs`.

**Payroll tables (see §8):** `technician_compensation` · `payroll_periods` · `payroll_period_hours` · `payroll_period_totals`.

---

## 6. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns least-busy tech who works that day, isn't off, has no clash, and is qualified for every booked service; refuses if none. **New this session:** optionally also checks the technician's actual `technician_hours` window (not just day membership), gated by `salon_settings.enforce_technician_hours` (default `false`, zero behavior change until opted in — see §9).
- **New this session: `create_booking` validates that every submitted service actually exists and is currently active for that salon**, server-side, regardless of which client (website, dashboard, wizard, technician-specific modal) submitted the request — closing a real, previously-tracked gap. See §9.
- Customer emails via Make; token Manage page (`?manage=`); per-tech read-only schedule links (`?tech=`) — **archiving a technician now genuinely invalidates their schedule link** (deactivating does not — see §9's Staff architecture for the exact decision and why).
- Dashboard: Today, Week (open-slot gaps), Insights, Customers (segments+tags+sort), **Payroll**, **Settings — all six sections now complete: Access & Security, Business Information, Business Hours, Services, Staff, Website**, **Aivy** (auto-briefing + chat, still shallow — see backlog). **The standalone "Technicians" nav item and view are gone** — everything it did now lives in Settings → Staff.
- **Admin Booking**, **Checkout & Payments**, **Payroll** — unchanged this session, still as described in §7/§8.
- **Owner Settings — Services (NEW, complete this session):** full CRUD, category-grouped collapsible list with search and archived-toggle, same lifecycle model as everything else. See §9.
- **Owner Settings — Staff (NEW, complete this session):** full CRUD, per-day working-hours editor (replacing the old day-only picker), qualifications checklist, time-off and schedule-link management absorbed from the old Technicians tab, scrollable modal (sticky head/footer) so the form works on any screen size. See §9.
- **Owner Settings — Website (NEW, complete this session):** a live "Test website sync" diagnostic — not a stored status, a real-time check against the same tables the website depends on, proactively flagging exactly the class of gap that caused this session's two real bugs (a technician with no hours configured, a technician or service with zero qualification links). See §9.
- **Website — fully converted to live data (NEW, complete this session):** every hardcoded data structure (`TECH_DB`, `SVC_DUR`, `SALON_HRS`, `WIZARD_DATA`, `TECH_SERVICES`) removed and replaced with a single `LIVE` object fetched from Supabase, scoped by salon, with an honest all-or-nothing load gate (no silent partial-load state) and one automatic retry. See §9 for the full architecture and the two real bugs this fixed.
- **Demo Salon** sandbox for all testing — Red Persimmon's real data untouched by this session's work except for one required, deliberate step: **`technician_hours` was backfilled for all 10 real Red Persimmon technicians** (see §9) — necessary groundwork for the website fix, not a behavior change (the new `enforce_technician_hours` flag stayed off throughout).
- Security: RLS locked on most tables; per-salon passcode/PIN/token gating; no secrets in site. **Known gap, unchanged:** `payments`/`payment_line_items` RLS still disabled (§7). **New table `technician_hours` has RLS enabled with a public-read policy**, matching `salon_hours`'s existing pattern — write access is only via the `update_technician_hours` RPC (`security definer`), same as every other Owner Settings table.
- Data-readiness audit — **redone this session, much more thoroughly, with real findings** (see §9's "Website/database reconciliation" — this fully supersedes the earlier, less rigorous "no seeding needed" note from before this session, which turned out to have missed real drift in the website's per-technician service catalogs).

---

## 7. Checkout & Payments Architecture

**Unchanged this session.** Full detail preserved below for reference.

### Core model: Expected vs. Actual Revenue

- **Expected Revenue** = `bookings.total_price` — the estimate captured at booking time. Never overwritten at checkout. Used for any booking still `confirmed`.
- **Actual Revenue** = `payments.amount` — the real charged amount, captured only at checkout. Excludes tip always.
- **Effective value per booking**: the real payment amount if one exists, otherwise the estimate.
- **Payroll/commission/technician performance source of truth** = `payment_line_items`, not `payments`.

### Database schema

**`payments`** — one row per checkout transaction (header): `id`, `salon_id`, `booking_id` (nullable), `customer_id` (nullable), `amount`, `discount_amount` (default 0), `tip_amount` (default 0), `payment_method` (`cash`\|`card`\|`other`), `source` (`manual`\|`pos`, default `manual`), `notes`, `created_by`, `created_at`.

**`payment_line_items`** — one row per service actually performed: `id`, `payment_id`, `salon_id`, `booking_id` (nullable), `service_id` (nullable), `service_name` (snapshot), `technician_id` (**NOT NULL**), `technician_name` (snapshot), `charged_price`, `tip_amount`, `voided_at`/`voided_by`/`void_reason` (nullable), `corrected_from_id` (nullable self-FK), `created_at`.

Indexes: `payment_line_items(payment_id)`, `(technician_id, created_at)`, `(salon_id, created_at)`, `(booking_id)`.

**Explicitly deferred:** split/multi-tender payments, deposits, refunds/voids at the payment level, gift cards, packages/memberships — architecture supports these additively.

**Known gap, not yet fixed:** `mark_booking_status`'s cancellation-notify path calls `velour_notify(...)` outside any exception guard.

**Known security gap, not yet fixed:** `payments`/`payment_line_items` RLS disabled — every other sensitive table has RLS enabled with no public policies (service-role Edge Functions only); these two are the exception.

### RPCs

**`create_booking(...)`** — single entry point for website + dashboard Admin Booking. **Updated this session** — see §9 for the two additions (service active/exists validation, technician-hours enforcement gate). No other logic changed.

**`checkout_booking(...)`**, **`mark_booking_status(...)`** — unchanged this session.

### Edge Functions

**`dashboard-read`** `ALLOWED` set — **updated this session**, now includes `technician_hours` in addition to everything previously listed (`customers`, `bookings`, `booking_services`, `technicians`, `services`, `technician_time_off`, `salon_hours`, `technician_links`, `technician_services`, `payments`, `salons`, plus the four payroll tables).

**`dashboard-write`** `ACTIONS` map — **updated this session**, gained: `upsert_service`, `set_service_active`, `archive_service`, `upsert_technician`, `set_technician_active`, `archive_technician`, `set_technician_services`, `update_technician_hours` — on top of everything previously listed. Same generic `{action, args}` → RPC proxy pattern, whitelist-only additions, zero logic changes to the function itself.

### Dashboard (`dashboard.html`)

Unchanged this session except: `loadAll()` now also fetches `technician_hours` (unfiltered by salon, matched client-side against loaded technicians — same established pattern as `technician_services`, since neither table carries a `salon_id` column of its own) and builds `store.technicianHours`. A pre-existing, unrelated third hardcoded-hours bug was also found and fixed here — see §9's "Dashboard-side duplicate found and fixed."

### What's still open

Unchanged from before this session — see the original list (Owner-Aivy tool-calling foundations, website inline validation, payment correction/void UI, split payments etc.) — plus one item resolved: **website inline email/phone validation is still not built** (unchanged, still open, see §10 item 12).

---

## 8. Payroll Architecture — **COMPLETE, unchanged this session**

Full detail preserved as-is from the prior version of this document — nothing in Payroll was touched this session. Core model (Live vs. Frozen), database schema (`technician_compensation`, `payroll_periods`, `payroll_period_hours`, `payroll_period_totals`), RPCs (`set_technician_compensation`, `create_payroll_period`, `update_payroll_hours`, `calculate_payroll_preview`, `close_payroll_period`), Edge Function extensions, dashboard tab design, security decisions, and testing approach all remain exactly as previously documented and accurate.

---

## 9. Owner Settings & Salon Management Architecture

**Status: ALL SIX SECTIONS COMPLETE — Access & Security, Business Information, Business Hours, Services, Staff, Website.** The consolidated Website Integration pass (previously deferred future work) is also complete, done ahead of schedule because it became necessary to finish Staff correctly (see below). This section now documents the full, final architecture of the entire module.

### Settings navigation (final, as shipped)

```
Settings
 ├─ Access & Security    (dashboard password, Payroll PIN)
 ├─ Business Information (name, phone, email, address, maps_url)
 ├─ Business Hours       (weekly hours, salon closures, conflict warning)
 ├─ Services             (add/edit/deactivate/archive, category-grouped)
 ├─ Staff                (add/edit/deactivate/archive, hours, qualifications, time off, schedule links)
 └─ Website              (live sync-check tool)
```

**The old standalone "Technicians" nav item and its entire view have been removed from the dashboard** — nav button, `<section id="view-technicians">`, `renderTechnicians()`, and every reference in `switchView`/`reloadData`/`refreshTechnicianRelatedViews` are gone. Every capability it used to provide (time off, schedule links) now lives inside Settings → Staff. This removal was done only after Staff was fully built and verified, per the established "verify replacement before retiring original" discipline.

Access & Security, Business Information, and Business Hours are unchanged from the prior version of this document (per-salon authentication, Payroll PIN, live-synced Business Information, the three-layer Business Hours model) — preserved as previously documented, not reproduced again here to keep this section focused on what's new.

### Services architecture (complete)

**Schema:** `services.archived_at` (nullable timestamptz) and `services.display_order` (integer). Both additive migrations, no data loss, `display_order` seeded immediately (alphabetical within category) so nothing changes visually on deploy.

**Why `display_order` was added now rather than deferred:** unlike `reengagement_weeks` (a column with genuinely no feature behind it, correctly left unused), `display_order` has a near-certain future need (owner-controlled reordering) and an asymmetric cost: adding it in the same migration that added `archived_at` cost one line; adding it later would mean a second migration plus a backfill against whatever order the UI had organically settled into by then. The column is currently backend-only — no reorder UI exists yet, and none should be built speculatively.

**`reengagement_weeks`** — confirmed still unused anywhere, deliberately left out of the Add/Edit form.

**RPCs (all `security definer`, `search_path=public`):**
- **`upsert_service(p_salon_id, p_service_id, p_name, p_category, p_price, p_duration_minutes, p_price_from default false, p_display_order default null)`** — insert (null `p_service_id`) or update. Validates name/category required, price ≥0, duration >0. Cross-salon check on edit (`SERVICE_NOT_FOUND`). Blocks editing an already-archived service (`SERVICE_ARCHIVED`). New services append to the end of their category's `display_order` unless an explicit value is given.
- **`set_service_active(p_salon_id, p_service_id, p_active)`** — toggles `active`. Blocked if already archived (`SERVICE_ARCHIVED`).
- **`archive_service(p_salon_id, p_service_id)`** — requires already-inactive (`ARCHIVE_REQUIRES_INACTIVE`), blocked if already archived (`SERVICE_ALREADY_ARCHIVED`), blocked if any future confirmed booking references the service **by name** — raises `SERVICE_HAS_FUTURE_BOOKINGS: <count>`.

**Dashboard UI:** category-grouped collapsible list, one category open by default on first visit (once per session, doesn't fight manual collapsing afterward), search that filters and auto-expands matches without losing input focus, a "Show archived" toggle (archived hidden by default), inactive rows shown muted with an explicit "Inactive" pill, Add/Edit sharing one modal, `price_from` as a simple checkbox, `display_order` never shown in the UI.

**Known gap, deliberately accepted, resolved by Staff's existence:** a brand-new service has zero technician qualifications until someone assigns them in Staff — flagged with an inline note in the Add Service form.

### Staff architecture (complete)

**Schema:** `technicians.archived_at` (nullable timestamptz, mirrors Services). **New table `technician_hours`:**

```sql
create table technician_hours (
  technician_id uuid not null references technicians(id) on delete cascade,
  day_of_week   text not null check (day_of_week in ('mon','tue','wed','thu','fri','sat','sun')),
  is_available  boolean not null default false,
  start_time    time,
  end_time      time,
  primary key (technician_id, day_of_week)
);
```
Mirrors `salon_hours`'s exact shape, technician-scoped instead of salon-scoped. RLS enabled, public-read policy (`public_read_technician_hours`, `qual: true`) matching `salon_hours`'s existing pattern.

**Why this table exists / what it replaces:** `technicians.available_days` (text array) only ever encoded *which days* a technician works, never *what hours* on those days — there was no hour-level technician availability concept anywhere in the system before this work. `technician_hours` is a strictly additive capability, not a migration of an existing concept.

**Backfill (both salons, complete):** for every technician, one row per day of week was seeded from `available_days` intersected with `salon_hours` (inherited start/end time, or `is_available=false` on any day the salon is closed) — verified by direct comparison against every technician's original `available_days`, 100% match, for both Demo (10 technicians, 70 rows) and Red Persimmon (10 technicians, 70 rows). `available_days` itself was **left in place, untouched, as inert legacy data** (see §4).

**RPCs:**
- **`upsert_technician(p_salon_id, p_technician_id, p_name, p_email, p_phone, p_available_days)`** — insert/update. Validates name required; email/phone reuse `create_booking`'s exact normalization. **`p_available_days` is always passed `null` by the current dashboard UI** — `technician_hours` is the real source of truth now. Cross-salon check, blocks editing an archived technician.
- **`set_technician_active(p_salon_id, p_technician_id, p_active)`** — toggles `active`. **Deliberately does not touch `technician_links` in either direction** — deactivation is temporary/reversible and must never break a technician's schedule link; only archiving does that. Blocked if already archived.
- **`archive_technician(p_salon_id, p_technician_id)`** — requires already-inactive, blocked if already archived, blocked if any future confirmed booking references the technician **by `technician_id`** (a real FK) — raises `TECHNICIAN_HAS_FUTURE_BOOKINGS: <count>`. **On success, deletes the technician's `technician_links` row** — this is the one and only point where a schedule link is invalidated. Reactivation deliberately does **not** auto-generate a new link — the owner uses the existing `reset_tech_token` action explicitly. Both halves verified end-to-end directly against Demo: deactivate → link still resolves; reactivate → same link still resolves, no new token generated; archive → link genuinely stops resolving (`get_tech_schedule` → `found:false`).
- **`set_technician_services(p_salon_id, p_technician_id, p_service_ids uuid[])`** — replaces a technician's full qualification set (delete-then-reinsert in one transaction). Validates every service id belongs to the same salon (`SERVICE_NOT_IN_SALON`) — necessary because `technician_services` carries no `salon_id` column of its own.
- **`update_technician_hours(p_salon_id, p_technician_id, p_hours jsonb)`** — same all-or-nothing shape as `update_salon_hours` (all 7 days, `MISSING_HOURS_FOR_AVAILABLE_DAY`, `END_TIME_MUST_BE_AFTER_START_TIME`), upserts via `on conflict (technician_id, day_of_week)`.

**Dashboard UI:** flat list (no category grouping — technician counts are small enough that grouping would add complexity without benefit), Active/Inactive shown with the same visual language as Services, Archived hidden by default behind a toggle. The Add/Edit modal was **redesigned mid-build for a real usability bug**: the original didn't fit on shorter screens with no way to scroll. Fixed with a proper scrollable-modal pattern — sticky header, independently-scrolling body, sticky footer, capped at ~88vh — via a new CSS modifier class (`.rmodal-card-scroll`) rather than editing the shared base modal style, to avoid regression risk to Services/Payroll/Business Hours modals. Inside the modal: a per-day working-hours editor (checkbox + start/end time per day, same row pattern as Business Hours), pre-filled from the salon's current hours for a brand-new technician or the technician's real saved hours when editing; a qualifications checklist (grouped by service category); time-off management and schedule-link Copy/Reset actions absorbed directly from the old Technicians tab. The Staff card's hours display is **compressed** — consecutive days sharing identical start/end times merge into one range (e.g. "Mon–Wed 10–6 · Fri 10–8").

**A shared refresh dispatcher (`refreshTechnicianRelatedViews`)** kept both the old Technicians tab and the new Staff tab in sync while both existed; since simplified now that the old tab is gone.

**A real, unrelated bug found and fixed while building this:** the Reschedule modal's technician dropdown (dashboard-side) never filtered by `active` at all — any technician, including deactivated ones, could appear as a reschedule target. Fixed (one-line filter, matching the `active!==false` convention used everywhere else).

### `create_booking` — updated (two additions, both server-side)

**1. Service validation:**
```sql
if p_services is not null then
  for svc in select * from jsonb_array_elements(p_services)
  loop
    if not exists (
      select 1 from services s
      where s.salon_id = p_salon
        and lower(trim(s.name)) = lower(trim(coalesce(svc->>'name', '')))
        and s.active = true
        and s.archived_at is null
    ) then
      raise exception 'SERVICE_NOT_AVAILABLE: %', svc->>'name';
    end if;
  end loop;
end if;
```
Applies to **every** caller (website, dashboard, Aivy wizard, technician-specific modal) — the server is now the actual enforcement point regardless of which client submitted the booking. Verified directly: a real active service books successfully; a fabricated service name is rejected; the exact reported bug (a real service, deactivated, then immediately attempted) is rejected — then reverted cleanly.

**2. Technician-hours enforcement (feature-flagged):** one new `AND` clause in the existing "no preference" auto-assign eligibility subquery, checking `technician_hours` for the requested day/time window — only when `salon_settings.enforce_technician_hours` is `true`, and only for auto-assign; an explicitly-requested technician is never blocked by this. Verified with the flag both on and off, and verified an explicit-technician booking succeeds outside that technician's hours even with the flag on (the deliberate bypass working as designed).

**New feature flag:** `salon_settings.enforce_technician_hours` (boolean, default `false` for every salon). Currently `false` for both Demo and Red Persimmon. Enabling it is a future, separate, deliberate decision.

### Website live-data architecture (replaces the entire hardcoded layer)

**What existed before, discovered via a full audit:** not two hardcoded structures as originally estimated, but **five**, plus a genuinely bigger one found once the audit went deep:
- `TECH_DB` — technician id + day-list, used for slot-generation eligibility.
- `WIZARD_DATA.technicians[].days` — a second, independent day-list copy, used by the Aivy chat wizard.
- The visible "Our Team" grid's own hardcoded `📅 Mon – Wed, Fri – Sun`-style text per card — a **third**, purely-display copy of the same day data.
- `SALON_HRS` — hardcoded salon hours, used for slot-generation boundaries (also independently duplicated a **third** time inside the *dashboard's* Week-view open-slot-gap finder, `SALON_HOURS_MIN` — found and fixed as part of this same audit, see below).
- `SVC_DUR` — hardcoded service durations.
- `WIZARD_DATA.services` — a second, independent service catalog (price/category/duration) with a hardcoded **single technician assignment per service** — a real simplification versus reality, since `technician_services` already correctly supports several technicians being qualified for the same service.
- `TECH_SERVICES` — a much larger, per-technician hardcoded service+price catalog (~150 lines) powering the separate "Book with your favorite technician" flow, entirely independently maintained from everything else.

**Reconciliation performed before any code was touched** (real database data compared line-by-line against every hardcoded structure):
- **Legacy items confirmed and removed:** "Full Set – Pink Only," "Dipping – Pink & White," and several more naming-drifted or genuinely-discontinued entries found during the main-grid mapping pass (7 rows total across the visible grid) correspond to nothing in the real database. Per an explicit decision, these are treated as legacy — not backfilled into the database — and simply no longer get a booking button on the website.
- **Two confirmed wrong qualification claims, corrected by switching to live data:** the website's hardcoded data claimed Alex was qualified for Dipping Powder and Ammu for Dipping Ombre; the real `technician_services` table says neither is. More seriously: `WIZARD_DATA.services` assigned **every lash service** to Ammu, while the real qualified technicians for lashes are Kristy and Tina — meaning the live chat wizard, before this fix, would have confidently recommended the wrong person for every lash booking. All of this is now correct by construction.
- **Price and duration values matched exactly, everywhere both existed** — the drift was entirely about presence/absence of items and qualifications, never about wrong numbers.

**What replaced all of it — one `LIVE` object, salon-scoped, honest about failure:**
```js
const LIVE = { services: [], technicians: [], techHours: {}, techQuals: {}, salonHours: {}, loaded: false, loadError: null };
```
Populated once by `loadLiveBookingData()`, which:
1. Fetches `services`, `technicians`, `salon_hours` — each scoped by `salon_id=eq.${SALON_ID}`.
2. Fetches `technician_hours` and `technician_services` — scoped by `technician_id=in.(...)` against *this salon's own* technician ids (both tables carry no `salon_id` column of their own). **This replaced an earlier version that fetched these two tables completely unfiltered across every salon at once, capped at `limit=500`** — a real, confirmed defect: total rows across both salons had already reached 574, exceeding that cap, meaning some technician's qualification or hours data could silently and unpredictably go missing depending on physical row order. Scoping by this salon's own technician ids removes the problem by construction.
3. **`dbGet()` now throws on any HTTP error or malformed response**, instead of silently returning `[]`. `loadLiveBookingData()`'s `LIVE.loaded = true` assignment only happens after every one of the above fetches has genuinely succeeded — there is no intermediate state where some data is fresh and some is silently empty. `ensureLiveData()` awaits the load, retries once (a genuine transient-network allowance), then returns `false` for good if it still fails. **Every booking entry point checks this return value and shows an honest, visible error state** instead of silently proceeding with an empty service list or a broken calendar.

**All four booking-affecting UI pieces now read from `LIVE`:**
- **Main Services grid** — each row tagged with a `data-live-name` attribute mapping its marketing label to the real database service name (46 of 53 rows mapped cleanly; 7 legacy rows deliberately left with no attribute and therefore no booking button). The "+" button injection now looks up `svcByName(row.dataset.liveName)` and only attaches a button if that service is currently active — verified directly: deactivating a service removes its button on next load; reactivating restores it.
- **"Book with your favorite technician" modal** — service list built from `LIVE.techQuals` joined to `LIVE.services` (`techServicesFor()`), replacing `TECH_SERVICES` entirely. This is the path that had the confirmed Ammu bug.
- **Aivy chat wizard** — categories/services from `LIVE.services`; technician-recommendation step calls `wizardQualifiedTechsFor(serviceId)`, showing **all** genuinely qualified, active technicians (with a "Best Available" fallback if none found).
- **Slot generation (`bmLoadSlots`)** — boundary computed from live `salon_hours`, further intersected with the chosen technician's live `technician_hours` for that day. Verified precisely: a technician's Tuesday hours (10–8) and Friday hours (10–9) produced genuinely different, correct last-bookable-slot times (7:15 PM vs. 8:15 PM) for the identical service duration.
- **"Our Team" grid's availability text** — computed live via `fmtAvailabilityLine()` (day-run compression, e.g. "Mon–Wed & Fri–Sun") from `LIVE.techHours`.

**Deliberately left untouched, per an explicit content-vs-logic boundary decision:** marketing descriptions/bios, FAQ text, Aivy's `SYSTEM_PROMPT` — copywriting, not structured data, scoped to a future Website Content/Aivy phase.

**Manage Appointment / Reschedule overlay** — confirmed to be a fully separate, self-contained IIFE that never touches `LIVE` or any service data. "Reschedule" cancels then redirects into the main site, which then goes through the now-fixed booking engine — this path inherits both fixes automatically. `get_booking_by_token`/`cancel_booking_by_token` confirmed still present and unaffected.

### Dashboard-side duplicate found and fixed (unrelated to the website)

A **third**, independent hardcoded salon-hours object (`SALON_HOURS_MIN`) was discovered inside the *dashboard's* Week-view open-slot-gap finder. Replaced with a live lookup against `store.salonHours` (already fetched by `loadAll()`), via a new `dayHours(date)` helper. Verified via direct comparison: exact match for every existing day, plus correct graceful degradation (`null` for an unknown/closed day) — strictly better than what it replaced.

### Two real bugs found and fixed (case studies)

**Bug 1 — "Book with Ammu" opened an empty, unbookable modal.**
- **Symptom:** editing Ammu's hours correctly updated her public availability badge, but her technician-specific booking modal showed zero services, while booking through the main Services grid worked fine.
- **Investigation, in order of elimination:** confirmed all of Ammu's qualifications pointed to active services (not a data problem); confirmed RLS/grants identical between `technician_services` and the working `technician_hours` (not a permissions problem); confirmed via `row_number() over (order by ctid)` that Ammu's rows sat safely within the first 500 of the (at the time) unbounded 574-row fetch (ruling out row-limit truncation *for this technician specifically*, though the limit itself was still a real, separate defect).
- **Actual root cause:** `LIVE.loaded` was computed from only three of five parallel fetches succeeding — `technician_hours` and `technician_services` could each silently fail and leave `LIVE.techQuals` empty, with nothing detecting or surfacing that failure.
- **Fix:** the full honest-failure/all-or-nothing rewrite described above.

**Bug 2 — a deactivated service remained bookable on the website, and the booking succeeded.**
- **Root cause, two layers, both confirmed and fixed:** (1) the main Services grid was 100% static HTML, never wired to any live data source; (2) `create_booking` had no server-side check that a submitted service was real or active.
- **Fix:** both layers fixed independently — the grid now checks live service data before offering a button, and `create_booking` now validates server-side regardless of client.

### New RPCs and migrations (this module, to date)

**Migrations:** `services.archived_at`, `services.display_order` · `technicians.archived_at` · `technician_hours` (new table + public-read RLS) — backfilled both salons · `salon_settings.enforce_technician_hours`.

**RPCs:** `upsert_service`, `set_service_active`, `archive_service` · `upsert_technician`, `set_technician_active`, `archive_technician`, `set_technician_services`, `update_technician_hours` · `create_booking` modified in place (signature unchanged).

### Remaining roadmap for this module

**None — the module itself is complete.** What remains is validation and rollout (§13, §10): one comprehensive manual/browser end-to-end validation pass on Demo, then the Red Persimmon production cutover (backfill already done; remaining steps are legacy-passcode-fallback removal and feature-flag decisions, as one deliberate action).

---

## 10. PRIORITIES (current)

**Launch blockers → then Kristy goes live:**

1. ~~Diagnose & fix duplicate bookings~~ — **DONE.**
2. ~~Walk-in entry in dashboard~~ — **DONE.**
3. **Security: rate-limit `aivy-chat`; booking spam protection (Turnstile).** **Still the only remaining Critical launch blocker, unchanged this session.**
4. ~~Test-data cleanup~~ — **DONE.**
5. **Browser-validate the full Checkout/Payments flow end-to-end.** Unchanged, still not done.
6. **Browser-validate the full Payroll flow end-to-end.** Unchanged, still not done.
7. ~~Complete Owner Settings (Services, Staff, Website tab)~~ — **DONE, in full**, including the consolidated Website Integration pass, ahead of the originally planned sequencing. **What remains:** the single production cutover for Red Persimmon (legacy passcode fallback removal + feature-flag decisions) — not yet performed, pending item 8.
8. **Comprehensive manual/browser end-to-end validation on Demo**, covering Staff, Services, Business Hours, all four website booking paths, dashboard↔website sync, and regression checks on untouched areas. A complete test plan (Action → Expected Result) has already been prepared and handed off — see §13. **Not yet executed** (no browser was available in the sessions that built this work). **This must happen before the Red Persimmon cutover.**
9. **GO LIVE** — real-world test with Kristy, blocked on #3, #5, #6, and the cutover following #8.

**Fast follows (after live, guided by real usage):**

10. Finish **Owner-Aivy** (tool-calling on foundations) — unchanged.
11. **Time-in / flexible scheduling** — unchanged.
12. **Website inline email/phone validation** — unchanged, still open.
13. **Payment line item correction/void UI** — unchanged, still open.
14. ~~Technician commission/payroll calculation~~ — **DONE.**
15. **Stale booking-wizard state bug** (`bm.date`/`bm.slotRaw` not fully refreshing between selections after "Back") — unchanged, still open, not investigated.
16. **`payments`/`payment_line_items` RLS gap** — unchanged, still open.

**Parked (post-first-results / need Kristy content / multi-salon):**

17. De-static website (gallery, reviews, editable content); Reputation Engine; multi-tenant hardening; custom domain; optional re-engagement email; full tech logins.
18. Split/multi-tender payments, deposits, refunds/voids, gift cards, packages/memberships.

---

## 11. Ideas backlog

Unchanged — see prior entries (Reputation Engine, owner interviews, repeatable onboarding, pricing validation, usage instrumentation, non-hardcoded schedule, lean Blueprint). **Note:** `technician_hours` is now a real, live instance of the "weekly default + exceptions" pattern previously only sketched for `salon_hours_exceptions` — the two should still be designed together whenever `salon_hours_exceptions` is picked up.

---

## 12. Tracked Technical Debt

*(Consolidates items previously scattered inline, plus new items found this session. Add new debt here going forward.)*

### Business Hours conflict banner reads from the wrong store (still open)

- **Root cause, confirmed via a jsdom dynamic trace, not static inspection:** `onBusinessHoursChanged()` filters `store.bookings` — declared in the initial `store` object but never written to anywhere in `loadAll()` or anywhere else. Permanently `[]`. Real data lives in `store.assembled`.
- **Proof:** with a genuine future conflicting booking loaded into `store.assembled`, the real function produced no warning; manually populating `store.bookings` in the shape the function expects made it render correctly — proving the function's own logic is right, only the data source is wrong.
- **Why it looked verified previously:** two separate, real, correctly-completed verifications exist nearby (a jsdom check of the *save* function's payload, and a live DevTools-confirmed check of server-side `OUTSIDE_BUSINESS_HOURS` rejection) — neither ever exercised this specific banner-rendering function with real data.
- **Proposed fix, not yet applied:** point the function at `store.assembled` instead.
- **Status:** still open, not touched — Services/Staff/Website work did not depend on or interact with this function.

### Demo data cleanup — one cross-salon booking mismatch (sandbox only, still not fixed, deliberately)

- Booking `81d585c2-f75e-44a7-90a2-0c254b6a9ff0` ("Spa Me Perfect Pedicure," Demo salon) has a `technician_id` belonging to Kevin, a Red Persimmon technician — confirmed the *only* such mismatch across the entire `bookings` table.
- Surfaced when a cross-salon ownership guard correctly refused to act on Kevin under the Demo salon id.
- Pre-existing sandbox data, not a code defect, not a Red Persimmon issue. Deliberately left alone — low priority, fix whenever convenient.

### `close_salon_day` doesn't backfill time-off rows for technicians added/reactivated after a closure

- Unchanged, still not fixed. Now directly relevant since Staff's archive/reactivate flow is live — worth picking up.

### `booking_services.service_id` still not populated by `create_booking`

- Unchanged, still true: only `service_name` is written, which is why Services' and Staff's archive-blocking checks, and `create_booking`'s new service-validation check, all match by name rather than id.

---

## 13. Manual Test Plan (prepared, not yet executed)

A complete, step-by-step Action → Expected Result test plan was prepared covering: Services (full CRUD, lifecycle, search, archive-blocking); Staff (full CRUD, hours editor validation, qualifications, time off, schedule links, lifecycle); Business Hours regression check; dashboard→website synchronization; all four website booking paths (Main Services grid, Book with Technician, Aivy wizard, Manage Appointment/Reschedule), including the exact two bugs found and fixed as explicit re-test scenarios; server-side validation checks; regression checks on untouched dashboard areas (Today, Week, Insights, Customers, Payroll, Access & Security, Business Information); confirmation the old Technicians page is fully gone with nothing lost.

**This plan has not yet been executed** — no browser was available in the sessions that built this work; every verification instead used direct database calls (real RPC tests against Demo, with cleanup, on every write path) and `jsdom`-based dynamic simulation fed either real captured data or realistic fixtures modeled on it. That is a meaningfully higher bar than "the code looks right," but it is not the same as a real click-through. **Running this plan is the explicit, named prerequisite before the Red Persimmon cutover** — see §10 item 8.

---

## 14. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. When founder is stressed, give the single next step, not the whole list. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling. One chat = one task; update this doc after milestones.

**Reinforced this session, worth restating explicitly:** every claim of "verified" or "tested" in this document means either (a) a real RPC call against Demo's live database, with cleanup, or (b) a `jsdom` simulation using real captured data or a realistic fixture modeled on data actually queried from the database — never a claim based on reading code and reasoning about what it "should" do. Several real bugs this session (the Ammu qualification failure, the deactivated-service booking gap, the dashboard's third hardcoded-hours copy) were only found because of this discipline — static code review alone would have missed all three. Continue this standard in any future chat.

**Claude's tool access, for any new chat:** direct read/write access to the Supabase database (migrations, RPC testing and verification, data cleanup, Edge Function deploys) — proven out extensively again this session. **Browser automation tools exist but require a connected Chrome browser** — check for a connected browser before assuming manual testing is required; if none is connected, produce a complete manual test plan instead of assuming untested code works. The founder-uploads-file → Claude-returns-complete-file → founder-deploys/tests working pattern remains unchanged.

**Salon-scoping discipline, reinforced this session:** any table without its own `salon_id` column (`technician_services`, `technician_hours`) must always be fetched pre-filtered by a caller-supplied, already-salon-verified id list (e.g., `technician_id=in.(...)` against this salon's own technicians) — never fetched unfiltered with only a row-count `limit` as the safety net. This was violated once (the website's original fetch), found, and fixed; treat it as a permanent rule for any future table with the same shape.
