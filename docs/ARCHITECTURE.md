# Velour — Salon Management Platform (Source of Truth)

Velour is an **AI-first operating system for independent nail salons**. First live client: **Red Persimmon Nails & Spa** (Manchester, NH; owner Kristy). Long-term goal: a **multi-tenant** platform where each salon is *configuration, not custom code*.

This doc is the product + engineering + business source of truth. **Update it after each milestone.**

**Document status as of this update:** The dashboard's broken-access-control vulnerability has been found, fixed, deployed, and validated end-to-end against live production infrastructure with a real browser. This is the single biggest change since the prior version of this document — see §6 (Security Model) and §7 (Dashboard Authorization) for full detail. Owner Settings (§10) remains complete and unchanged. Owner-Aivy's authentication is now formally tracked as separate, pre-existing technical debt (§13), explicitly out of scope for this rollout.

---

## 1. Vision & strategy

- **Wedge:** the best AI-powered operating system for independent nail salons — not a feature-for-feature clone of Fresha/GlossGenius.
- **Differentiator:** the complete ecosystem — Website → Booking → CRM → Dashboard → Customer Aivy → Owner Aivy — not just a chatbot. **Aivy is the core brand.**
- **Stage goal:** get the first **5–10 paying salons**. Prove demand and repeatability before scaling features.
- **Feature filter:** every feature must (1) increase salon revenue, (2) reduce owner workload, or (3) improve customer experience. If not, don't build it.
- **Current #1 risk:** "will salons other than Kristy pay?" — unproven. Priority is a real-world test with Red Persimmon, then client #2.

---

## 2. Stack & key IDs

- **Website** — static `index.html` (deliverable file name: `website.html`). Deployed via **Cloudflare Workers, static assets, GitHub-integrated auto-deploy** (repo: `saikumar761997/velour-platform`, branch `main`; build command assembles `website/index.html` → `public/index.html` and `dashboard/velour-dashboard.html` → `public/dashboard.html`; every push to `main` redeploys automatically). Live at `https://velour-platform.redpersimmon.workers.dev/`. Calls Supabase **directly** with the anon key via a generic `dbGet()`/`dbRpc()` helper — no Edge Function proxy on this side, protected by permissive public RLS policies on `salons`, `services`, `technicians`, `salon_hours`, `technician_hours`, `technician_services`. `dbGet()` throws on any failure instead of silently returning `[]` (honest all-or-nothing load gate).
- **Dashboard** — static `velour-dashboard.html` (deliverable file name: `dashboard.html`), served at `/dashboard.html` on the same Worker as above. Per-salon passcode-gated. `CONFIG.SALON_ID` is a hardcoded per-deployment constant (this deployment: Red Persimmon) — the frontend is single-tenant per build; multi-tenancy lives entirely in the backend authorization layer (§7).
- **Supabase project:** `hydhezpeuhqhcugnpupu`. Red Persimmon salon id `a0000000-0000-0000-0000-000000000001`. Demo salon id `d0000000-0000-0000-0000-000000000001` (permanent sandbox, safe to wipe/reseed anytime).
- **Edge Functions:** `dashboard-read`, `dashboard-write` (both rewritten this project — see §7), `owner-aivy` (unchanged, separate legacy auth — see §13), `aivy-chat` (customer-facing website assistant, unrelated to this project).
- **Email:** Make.com. **Deployment:** Cloudflare Workers (GitHub-integrated). **Version control:** GitHub, `saikumar761997/velour-platform`, private.

---

## 3. Canonical models (never diverge)

- **Revenue — Expected vs. Actual:** Expected = `bookings.total_price` (estimate at booking time, never overwritten). Actual = `payments.amount` (real charged amount, captured only at checkout, excludes tip). Payroll/commission source of truth = `payment_line_items`, not `payments`.
- **Payroll — Live vs. Frozen:** effective-dated compensation history, never overwritten (close-and-open only); live preview vs. frozen close.
- **Business Hours — Weekly Default vs. Enforcement:** `salon_hours` is the weekly default; `salon_settings.enforce_business_hours` gates whether bookings outside those hours are rejected server-side.
- **Technician Hours — Weekly Default, per-technician:** `technician_hours` is the single source of truth for a technician's working days *and* hours (one row per technician per day of week, `is_available`/`start_time`/`end_time`, `day_of_week` stored as `'sun'..'sat'` text, not integers). `technicians.available_days` (old text-array column) is **inert legacy data** — never read or written by any code path. If you find a code path reading it, that's a bug.
- **Dates:** `localDateStr()` is the only correct way to get "today" in the dashboard; never reintroduce `toISOString().slice(0,10)`-style computation (UTC-unsafe).
- **Customer tags:** VIP = spend ≥ $300 or ≥6 visits; Lapsed = ≥1 visit and >8 weeks; Regular = ≥2 active; New = 0–1.
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work. **This is now enforced architecturally, not just by convention** — see §7.
- **Lifecycle model:** `active` boolean = reversible; `archived_at` = permanent, requires already-inactive; never delete; archive blocked by future confirmed bookings. Used identically by Services and Staff (technicians).

---

## 4. Database (key tables)

`salons` · `salon_settings` (per-salon `dashboard_passcode_hash`, `payroll_passcode_hash`, `enforce_business_hours`, `enforce_technician_hours`) · `salon_hours` · `technicians` (`available_days[]` legacy/inert; `active`; `archived_at`) · `technician_services` (qualifications join table, no `salon_id` column) · `technician_hours` (day/hour availability, no `salon_id` column, `day_of_week` is text) · `technician_links` (locked read-only tokens) · `services` (`archived_at`, `display_order`) · `customers` (`source` constrained to `website`/`walk_in`/`phone`/`manual`/`referral`) · `bookings` (`booking_date`+`start_time`/`end_time`, `status`, `total_price`, `manage_token`, `created_by`), `booking_services` (no `salon_id` column) · `payments` (no RLS — see §13) · `payment_line_items` (no RLS — see §13) · `technician_time_off` (has its own `salon_id` column directly) · `email_logs`. **Payroll tables:** `technician_compensation`, `payroll_periods` (has own `salon_id`), `payroll_period_hours` (no `salon_id`, joins via `payroll_period_id`), `payroll_period_totals` (no `salon_id`, joins via `payroll_period_id`).

---

## 5. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- "No preference" assigns least-busy qualified technician; optionally checks real `technician_hours` window, gated by `enforce_technician_hours` (default off).
- `create_booking` validates every submitted service is real and active, server-side, regardless of caller.
- Customer emails via Make; token Manage page (`?manage=`) backed by `get_booking_by_token`/`cancel_booking_by_token` (anon-key, token-authorized, no salon scoping needed at that layer since the token itself is the authorization); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week, Insights, Customers, Payroll, Settings (all six sections), Aivy (shallow — see §13), Admin/Walk-in Booking, Checkout & Payments.
- Owner Settings — Services, Staff, Website (Website: live "Test website sync" diagnostic, not stored state).
- **Dashboard and website are now deployed together on Cloudflare Workers with GitHub auto-deploy — no more manual file uploads.**
- **The dashboard authorization layer is live, deployed, and validated (§7).**

---

## 6. Security Model

### 6.1 Trust boundaries

Two structurally separate trust boundaries exist, and they must never be conflated:

1. **The public website** (`website.html`) — anon key, governed entirely by Postgres RLS policies. No Edge Function involvement for reads. `create_booking` and the token-based Manage Appointment RPCs (`get_booking_by_token`, `cancel_booking_by_token`) are called directly with the anon key; their own internal logic (or, for tokens, the unguessable token itself) is the security boundary, not RLS.
2. **The passcode-gated dashboard** (`dashboard.html`) — service-role key held server-side in two Edge Functions (`dashboard-read`, `dashboard-write`), never exposed to the client. RLS is irrelevant to this boundary (service-role bypasses it by design); **the Edge Functions themselves are the entire security boundary.**

Owner-Aivy (`owner-aivy`) is a third boundary, structurally different from both — see §13.

### 6.2 The vulnerability that was found and fixed

Both dashboard Edge Functions verified a caller's passcode against a claimed `salon_id`, then treated that verification as a boolean gate with no lasting effect — every read's table filter and every write's RPC arguments were still taken directly from the client's own request, unchecked against what had just been authenticated. A session that knew any one salon's passcode could read or write **any other salon's data** by simply changing the filter/argument values in the request, independent of which salon's passcode it had proven knowledge of.

**Confirmed live, not theoretically:** a session authenticated with Demo's passcode successfully read Red Persimmon's real bookings (22), customers (21), and payments (8) before the fix. Root cause: authentication and authorization were two disconnected steps — nothing bound the salon proven in step one to the data touched in step two.

### 6.3 The fix — centralized authorization layer

A single shared module, `_shared/authz.ts`, is now the sole authority for salon identity for the remainder of any dashboard request. Full detail in §7. Core properties:

- **Bind once, trust nowhere else.** `resolveAuthScope()` runs immediately after passcode verification and produces `AUTH_SCOPE`, the only salon identity that exists for the rest of the request. Client-supplied `salon_id`/`p_salon_id` values are never read again after this point — they are either overwritten (for arguments) or ignored entirely (for query filters).
- **Default-deny.** An unregistered table or action is rejected before any authorization logic runs — this was already true before the fix; what changed is that *registered* things are now also correctly scoped.
- **Two-step ID resolution, no PostgREST embeds.** Ownership is resolved with plain `select`/`in()` queries, never PostgREST's `table!inner(...)` resource-embedding syntax — deliberately, for reliability and to avoid depending on foreign-key detection behavior.
- **Structured, internal-only reason codes.** Every authorization decision (`direct_ownership`, `inherited_ownership`, `salon_mismatch`, `entity_not_registered`, `record_not_found`, `no_owned_rows`, `missing_record_id`) is logged via `console.log`, never surfaced to the client.
- **`AUTH_SCOPE` is a `Set<string>`, not a scalar, from day one** — today it always holds exactly one salon id, but this means future multi-location support (one authenticated session legitimately spanning several salons under one owner) is a change to `resolveAuthScope()`'s return value only, never to the registries, resolvers, or either Edge Function's control flow.

### 6.4 Legacy passcode fallback — removed

The old no-`salon_id` fallback (checking against a single global `DASHBOARD_PASSCODE` environment variable) has been **fully removed** from `dashboard-read` and `dashboard-write`. `verifyPasscode()` now returns `false` immediately if no `salon_id` is provided — there is no code path left that can authenticate without identifying a specific salon. Confirmed safe: exhaustive source audit found zero call sites in `dashboard.html` that omit `salon_id`, and no external scripts/tools were found to depend on the legacy path.

### 6.5 Known residual risk, deliberately accepted for now

`_shared/authz.ts` is **duplicated identically into both Edge Functions**, not imported as a true shared module. This is not the frozen design — the frozen design called for one shared file imported by both functions. It happened because a first deploy attempt sent placeholder content for the shared-file import path (a real mistake, caught and corrected immediately, see §14), and rather than guess again at the deploy tool's cross-function relative-import resolution under time pressure, both functions were made fully self-contained instead. Functionally verified identical and correct in both copies. **Any future change to the authorization logic must be applied to both files.** Revisiting true code-sharing (either by properly verifying the relative-import path, or via a Supabase database branch to test it safely) is tracked as follow-up work, not urgent.

---

## 7. Dashboard Authorization Architecture (NEW, this project)

### 7.1 Authentication flow

1. Client sends `{ salon_id, passcode, ...rest }` to `dashboard-read` or `dashboard-write`.
2. `resolveAuthScope(salon_id, passcode)`: calls `verifyPasscode()`, which calls the `verify_dashboard_passcode(p_salon_id, p_passcode)` RPC (unchanged this project — per-salon hash comparison via `pgcrypto`). Returns `null` on any failure (missing `salon_id`, wrong passcode) → `401 unauthorized`, exactly as before.
3. On success, `resolveAuthScope` returns `new Set([salon_id])` — this is `AUTH_SCOPE`, and it is the only salon identity trusted for the rest of the request.
4. Payroll-gated tables/actions additionally require `verifyPayrollPin()` (unchanged logic, independent of the dashboard passcode) before proceeding.

### 7.2 `ENTITY_REGISTRY` — single source of truth for read scoping and write ownership

```ts
type EntityConfig =
  | { kind: "direct"; salonCol: string; payrollGated?: boolean }
  | { kind: "via"; parent: string; key: string; payrollGated?: boolean }
  | { kind: "self" };
```

16 registered entities: 11 `direct` (own `salon_id` column — `customers`, `bookings`, `technicians`, `services`, `technician_time_off`, `salon_hours`, `technician_links`, `payments`, `technician_compensation`, `payroll_periods`, plus `salons` as `self`), 5 `via` (no own `salon_id`, ownership inherited through a parent — `technician_hours`/`technician_services` via `technicians`, `booking_services` via `bookings`, `payroll_period_hours`/`payroll_period_totals` via `payroll_periods`).

Adding a new table = one line here. `PAYROLL_TABLES` is derived from this registry (`payrollGated: true` entries), not separately maintained.

### 7.3 `ACTION_REGISTRY` — single source of truth for write bindings

```ts
type ActionConfig =
  | { rpc: string; kind: "salonArg"; arg: string; payroll?: boolean }
  | { rpc: string; kind: "recordBind"; arg: string; entity: string; payroll?: boolean };
```

28 registered actions: 18 `salonArg` (the RPC already takes a salon parameter — that argument is **overwritten** with `AUTH_SCOPE`'s value before the call, never validated-then-trusted) and 10 `recordBind` (the RPC takes only a bare record id — ownership is resolved from the record itself via `ENTITY_REGISTRY` and compared against `AUTH_SCOPE` before the RPC is ever invoked; mismatch → `403 cross_salon_denied`, RPC never called).

All 10 `recordBind` actions resolve ownership in a single hop (confirmed against live foreign keys before implementation — every record-bind entity carries its own `salon_id` column directly, no chain needed in practice, though the resolver supports arbitrary chain depth for future entities that might need it).

### 7.4 Read path (`dashboard-read`)

`buildScopedQuery(table, clientQuery, scope)`:
- `self` (`salons`): forces `id=eq.<scope>`, strips any client-supplied `id` filter.
- `direct`: strips any client-supplied filter on the salon column, injects `salonCol=eq.<scope>` (or `in.()` for a multi-salon future scope).
- `via`: if the client already narrows by the entity's own join key (a chunked `booking_services` fetch, a specific `payroll_period_id` lookup), that narrowing is **verified** with one bounded query (`id IN (requested ids) AND owned-by-scope`) rather than discarded and replaced with the entire salon's history — this matters for correctness (a specific payroll period's totals must not become every period's totals) and for performance (cost scales with the request, not with total salon history). If the client sends no filter on the key at all (only reached today by `technician_hours`/`technician_services`, whose owned set is bounded by technician count), the full owned set is fetched.
- `select=` (PostgREST resource embedding) is always stripped — no current dashboard call uses it, and stripping it closes a narrow residual risk around embedded rows potentially not sharing the parent's `salon_id` in a future data-integrity edge case.

### 7.5 Write path (`dashboard-write`)

For each action, `ACTION_REGISTRY` determines binding:
- `salonArg` → `writeArgs[cfg.arg] = AUTH_SCOPE value`, unconditionally.
- `recordBind` → `authorizeRecordBind(entity, recordId, scope)` resolves the record's true salon via `ENTITY_REGISTRY` (walking a `via` chain if needed, capped at a defensive recursion depth to fail closed rather than hang on a hypothetical future misconfigured cycle) and compares to `scope`.

### 7.6 Hardening found during self-review (fixed before deploy)

- **Prototype-chain lookup bypass:** `REGISTRY[key]` on a plain object walks the JS prototype chain — a `table`/`action` value of `"__proto__"` would return `Object.prototype` (truthy), defeating a naive `!REGISTRY[key]` not-registered check. Fixed with a `hasOwn()` helper (`Object.prototype.hasOwnProperty.call`) used everywhere a registry is checked.
- **Query-building bug:** the original `via`-read design discarded any client-supplied join-key filter and always substituted the entire salon-owned id set — proven, with real data, that this would have broken `payroll_period_totals`'s "view one period" behavior into "return every period ever." Fixed by verifying the client's requested ids against ownership instead of overriding them.
- **Recursion depth guard:** `resolveSalonForEntity`'s chain-walk had no cycle protection. Not currently reachable, but now fails closed (denies) rather than hanging, in case a future registry entry is accidentally misconfigured into a cycle.
- **Unbounded read cost:** the query-building fix above also closed a performance concern — the original design's parent-id lookup for `via` entities had no bound and would have grown with total salon history forever; the corrected version's cost scales with the client's own request size for the common case.

---

## 8. Booking Architecture

`create_booking(p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start, p_end, p_duration, p_price, p_notes, p_services, p_source default 'website', p_customer_id default null, p_created_by default null)` — single entry point for website + dashboard Admin Booking. Validates every submitted service is real and active, server-side, regardless of caller. `p_source` is constrained by `customers_source_check` to `website`/`walk_in`/`phone`/`manual`/`referral` — the RPC creates a customer record using this value if one doesn't already exist for the phone number.

`reschedule_booking(p_booking, p_date, p_start, p_tech default null)`, `mark_booking_status(p_booking, p_status, p_reason default null, p_by default 'salon')` (covers cancel/no-show/completed), `checkout_booking(p_booking, p_lines, p_payment_method, p_discount default 0, p_notes default null, p_created_by default null)` — `p_lines` requires `charged_price`, `tip_amount`, and a valid `technician_id` per line (not `price`/`quantity` — a plausible-looking but wrong shape that will fail with `INVALID_LINE_AMOUNT`/`LINE_MISSING_TECHNICIAN`). Internally calls `mark_booking_status(..., 'completed', ...)` on success.

**Website Manage Appointment (`?manage=<token>`):** `get_booking_by_token(p_token)` (read), `cancel_booking_by_token(p_token)` (the only mutation available from this surface). **"Reschedule" on the website calls the same `cancel_booking_by_token` RPC as "Cancel"**, then redirects to the booking flow — it is cancel-then-rebook by design, not an atomic reschedule; a customer can lose their original slot before securing a new one. This is intentional (the confirm-dialog copy says so explicitly) but worth a product decision (see §13).

---

## 9. Checkout & Payments Architecture

Unchanged this project. **Core model:** Expected Revenue = `bookings.total_price` (never overwritten at checkout); Actual Revenue = `payments.amount`; payroll/commission source of truth = `payment_line_items`. **Schema:** `payments` (header row per transaction) and `payment_line_items` (one row per service performed, `technician_id` NOT NULL, supports future correction via `voided_at`/`corrected_from_id`). **Explicitly deferred:** split/multi-tender payments, deposits, refunds/voids UI, gift cards, packages/memberships. **Known gap:** RLS disabled on both tables (§13).

---

## 10. Payroll Architecture

Unchanged this project. Live vs. Frozen model (effective-dated compensation history, close-and-open never overwrite). Schema: `technician_compensation`, `payroll_periods`, `payroll_period_hours`, `payroll_period_totals`. RPCs: `set_technician_compensation`, `create_payroll_period`, `update_payroll_hours` (requires all 7 days if updating `technician_hours` in the same session — a different RPC, don't confuse the two), `calculate_payroll_preview`, `close_payroll_period`. Payroll PIN gates both reads (via `PAYROLL_TABLES`) and writes (via `ACTION_REGISTRY`'s `payroll: true` flag), independently of the dashboard passcode — confirmed server-side enforced on both paths, not just client-side UI gating.

---

## 11. Owner Settings & Salon Management Architecture

Unchanged this project — all six sections complete: Access & Security (dashboard passcode + Payroll PIN, both now fully per-salon), Business Information, Business Hours (three-layer: weekly default, `salon_hours`, `enforce_business_hours`), Services (full CRUD, category-grouped, archive-blocked by future bookings, matched by *name* since `booking_services.service_id` is still unpopulated), Staff/Technicians (full CRUD, `technician_hours` is the source of truth for availability, qualifications via `technician_services`, deactivating never touches schedule links, only archiving does), Website (live sync-check diagnostic).

---

## 12. Website Architecture

Fully live-data (no hardcoded `TECH_DB`/`SVC_DUR`/`SALON_HRS`/`WIZARD_DATA`/`TECH_SERVICES` structures remain). A single `LIVE` object, fetched from Supabase on every page load, scoped by the deployment's hardcoded `SALON_ID` constant, with an honest all-or-nothing load gate (`dbGet()` throws on failure; nothing proceeds with partial data). Never call `SALON_ID` a `const` mutable in new work — it genuinely is a `const`, any per-request salon override (as used for Demo testing this project) must be done by passing an explicit id into `dbRpc()`/direct fetch calls, not by reassigning the constant. Booking-affecting surfaces: main service grid, technician-specific modal, Aivy wizard, slot generation, Manage Appointment overlay (token-based, `?manage=`) — all confirmed reading live data and functioning correctly end-to-end this project.

---

## 13. Current Technical Debt (consolidated)

**New, discovered this project:**
1. **Owner-Aivy authentication is separate, legacy, and single-tenant.** `owner-aivy` Edge Function checks `passcode !== DASHBOARD_PASSCODE` (a single global env var) with no `salon_id` parameter at all — structurally cannot support per-salon or multi-tenant use. Its system prompt is also hardcoded to `"Kristy at Red Persimmon Nails & Spa"`. Pre-existing, not introduced by this project, deliberately out of scope for this rollout. Needs its own design project, same rigor as the dashboard authorization work.
2. **Double-`unlock()` freezes the dashboard tab.** Calling `unlock()` a second time without a page reload stacks overlapping `boot()`/`loadAll()` cycles with no in-flight guard, freezing the renderer. No known normal user path triggers this. Low priority.
3. **`_shared/authz.ts` duplicated, not truly shared** (§6.5).
4. **Website "Reschedule" is cancel-then-rebook, not atomic** (§8) — product decision needed on whether this should become a true reschedule-by-token RPC.

**Pre-existing, unaffected by this project, still open:**
5. `payments`/`payment_line_items` RLS disabled — every other sensitive table has RLS with no public policies; these two are the exception (mitigated by both only ever being touched via service-role Edge Functions, but not a substitute for RLS).
6. `mark_booking_status`'s cancellation-notify call not exception-guarded.
7. Business Hours conflict banner reads from `store.bookings` (always empty) instead of `store.assembled` — root cause confirmed, fix proposed, not applied.
8. One Demo sandbox booking has a cross-salon technician mismatch (Kevin, a Red Persimmon technician, linked to a Demo booking) — surfaced incidentally by this project's cross-salon ownership checks correctly refusing to act on it. Sandbox-only, deliberately left alone.
9. `close_salon_day` doesn't backfill time-off rows for technicians added/reactivated after a closure.
10. `booking_services.service_id` still not populated by `create_booking` (name-matching used throughout instead).
11. `aivy-chat` rate limiting / Turnstile not implemented — the one remaining Critical launch blocker unrelated to this project.
12. Website inline email/phone validation not built (server already validates; this is a UX polish item).
13. Payment line item correction/void UI — schema ready, nothing built.
14. Stale booking-wizard state bug on the website (pre-existing, not investigated).

---

## 14. This Project's Process Notes (worth preserving)

- The vulnerability was found through targeted, adversarial code tracing prompted by a routine question about consistent authorization patterns — not through a scheduled audit. Worth remembering: "does every RPC actually check what it assumes it can trust" is a question worth asking proactively, not just when something breaks.
- Every claim of "verified" in this project meant one of: a live proof-of-concept against real Supabase data, a direct SQL reproduction of the exact query/RPC logic being deployed, or (for the final phase) a real, connected browser driving the actual deployed system — never a claim based on reading code and reasoning about what it "should" do.
- Two real deployment mistakes occurred and were caught before harm: a first `dashboard-read` deploy that accidentally sent placeholder content for the shared module (caught immediately, fixed by inlining), and a build-command filename mismatch during the Cloudflare Pages/Workers setup (caught via the build log, fixed by correcting the filename). Both are documented honestly above rather than smoothed over, per this project's own standard of not overstating verification.
- Full regression matrix was executed against the **live deployed system** with a real connected browser, using Demo credentials — not simulated. Every stop-and-fix cycle during that matrix (5 total) turned out to be a mistake in test-script parameters (wrong RPC signature, wrong enum value, wrong day-of-week format), never a defect in the deployed code — each was verified via direct SQL before being dismissed as non-blocking, not assumed.

---

## 15. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling, push back on scope creep even mid-validation. One chat = one task where practical; update this doc after milestones. Every session should end with an updated `ARCHITECTURE.md`, an implementation handoff, and a new-chat starter prompt — see the companion documents delivered alongside this one.
