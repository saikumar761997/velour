# Velour — Salon Management Platform (Source of Truth)

Velour is an **AI-first operating system for independent nail salons**. First live client: **Red Persimmon Nails & Spa** (Manchester, NH; owner Kristy). Long-term goal: a **multi-tenant** platform where each salon is *configuration, not custom code*.

This doc is the product + engineering + business source of truth. **Update it after each milestone.** Written for a future engineer (human or AI) joining with zero prior context — if something here is unclear without outside knowledge, that's a bug in this document.

**Document status as of this update:** Two major projects are now complete and frozen (see §17 Frozen Architectural Decisions): the dashboard broken-access-control fix, and `aivy-chat` rate limiting + Turnstile. The project is now entering a content/conversion phase (removing fake content, real photos, premium redesign) followed by a Website CMS build — see §14 (Version 2 Architecture) for that vision, clearly marked as **not yet built**.

---

## 1. Vision & strategy

- **Wedge:** the best AI-powered operating system for independent nail salons — not a feature-for-feature clone of Fresha/GlossGenius.
- **Differentiator:** the complete ecosystem — Website → Booking → CRM → Dashboard → Customer Aivy → Owner Aivy — not just a chatbot. **Aivy is the core brand.**
- **Stage goal:** get the first **5–10 paying salons**. Prove demand and repeatability before scaling features.
- **Feature filter:** every feature must (1) increase salon revenue, (2) reduce owner workload, or (3) improve customer experience. If not, don't build it.
- **Current phase:** launch readiness for Red Persimmon (final audit, real content, security hardening), followed by a conversion-focused redesign and a Website CMS — the CMS is the structural prerequisite for onboarding salon #2, since the website today is hardcoded per deployment, not configuration. See `NEXT_PROJECT_ROADMAP.md` for the full sequencing.

---

## 2. Stack & key IDs

- **Website** — static `index.html` (deliverable file name: `website.html`). Deployed via **Cloudflare Workers, static assets, GitHub-integrated auto-deploy** (repo: `saikumar761997/velour-platform`, branch `main`; every push to `main` redeploys automatically). Live at `https://velour-website.redpersimmon.workers.dev/`. Calls Supabase **directly** with the anon key via a generic `dbGet()`/`dbRpc()` helper for *reads*, protected by permissive public RLS policies on `salons`, `services`, `technicians`, `salon_hours`, `technician_hours`, `technician_services`. `dbGet()` throws on any failure instead of silently returning `[]` (honest all-or-nothing load gate). **Booking is the exception to the direct-call model:** as of July 31, 2026 the booking flow posts to the `booking-create` Edge Function rather than calling `create_booking` with the anon key — see §8.2. Also embeds the Aivy chat widget (§13).
- **Dashboard** — static `velour-dashboard.html`, served from its **own separate Worker** at `https://velour-dashboard.redpersimmon.workers.dev/`. Per-salon passcode-gated. `CONFIG.SALON_ID` is a hardcoded per-deployment constant (this deployment: Red Persimmon) — the frontend is single-tenant per build; multi-tenancy lives entirely in the backend authorization layer (§7).
- **Kiosk** — static `kiosk/index.html`, the in-store walk-in sign-in surface. Writes through one RPC, `join_walkin_queue` (see §8.1).
- **⚠️ Two Workers, not one.** The website and dashboard are separate Cloudflare Workers on separate hostnames. An earlier `velour-platform` project name no longer exists. **Renaming a Cloudflare project silently breaks every hardcoded origin allowlist that references it** — this has already caused one real production outage (§18).
- **Supabase project:** `hydhezpeuhqhcugnpupu`. Red Persimmon salon id `a0000000-0000-0000-0000-000000000001`. Demo salon id `d0000000-0000-0000-0000-000000000001` (permanent sandbox, safe to wipe/reseed anytime).
- **Edge Functions:** `dashboard-read`, `dashboard-write` — both rewritten in the dashboard authorization project, see §7. `owner-aivy` — per-salon auth as of v4, see §16. `aivy-chat` — customer-facing website assistant, see §13. `booking-create` — Turnstile gate in front of `create_booking`, the website's only booking write path, see §8.2. **Version numbers are deliberately not recorded here**: they change on every deploy and a hand-maintained list always drifts. Run `list_edge_functions` to see what is actually live.
- **Email:** Make.com. **Deployment:** Cloudflare Workers (GitHub-integrated). **Version control:** GitHub, `saikumar761997/velour-platform`, private.

---

## 3. Canonical models (never diverge)

- **Revenue — Expected vs. Actual:** Expected = `bookings.total_price` (estimate at booking time, never overwritten). Actual = `payments.amount` (real charged amount, captured only at checkout, excludes tip). Payroll/commission source of truth = `payment_line_items`, not `payments`.
- **Payroll — Live vs. Frozen:** effective-dated compensation history, never overwritten (close-and-open only); live preview vs. frozen close.
- **Business Hours — Weekly Default vs. Enforcement:** `salon_hours` is the weekly default; `salon_settings.enforce_business_hours` gates whether bookings outside those hours are rejected server-side.
- **Technician Hours — Weekly Default, per-technician:** `technician_hours` is the single source of truth for a technician's working days *and* hours (one row per technician per day of week, `is_available`/`start_time`/`end_time`, `day_of_week` stored as `'sun'..'sat'` text, not integers). `technicians.available_days` (old text-array column) is **inert legacy data** — never read or written by any code path. If you find a code path reading it, that's a bug.

  **This has actually happened.** `aivy-chat`'s `buildSystemPrompt` read `available_days` to tell customers which days each technician works. Because nothing writes to the column, it was frozen at months-old values, and two technicians (Alex, Ammu) held `NULL` — triggering an `"Every day"` fallback, so Aivy told customers Ammu was available Monday–Thursday when she works Friday–Sunday only. Fixed July 28, 2026: now reads `technician_hours`, and the fallback admits uncertainty ("schedule varies — ask the customer to call to confirm") instead of inventing availability. Verified live on the production site for both technicians. **The column should eventually be dropped, not just documented as inert** — a dead column that still returns plausible-looking data is a trap that documentation alone did not prevent.
- **Dates:** `localDateStr()` is the only correct way to get "today" in the dashboard; never reintroduce `toISOString().slice(0,10)`-style computation (UTC-unsafe).
- **Customer tags:** VIP = spend ≥ $300 or ≥6 visits; Lapsed = ≥1 visit and >8 weeks; Regular = ≥2 active; New = 0–1.
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work. Enforced architecturally in the dashboard authz layer (§7) and in `aivy-chat`'s `SALON_ORIGINS` map (§13); **not yet true of the website's content**, which is still hardcoded per deployment — see §14.
- **Lifecycle model:** `active` boolean = reversible; `archived_at` = permanent, requires already-inactive; never delete; archive blocked by future confirmed bookings. Used identically by Services and Staff (technicians).

  **Archived rows must be filtered out of every picker and filter UI, and that is easy to miss.** The dashboard's Today/Week technician filter (`populateTechFilters`) listed *every* technician row that had ever existed, archived ones included — while the checkout modal, on the same page, filtered correctly. Fixed July 31, 2026: the filter now excludes `archived_at`-set technicians and falls back to "All technicians" if the currently-selected one disappears from the list. Deactivated-but-not-archived staff are deliberately kept in the list — they can still have upcoming bookings worth filtering by. Anywhere a new dropdown is built over a lifecycle-managed table, this filter is required, not optional.
- **Rate-limiter counting model:** fixed-window counters, keyed by `(salon_id, action, key_type, key_value, window_start)` — correctness comes from the window being part of the key, never from a cleanup job having run. See §13.

---

## 4. Database (key tables)

`salons` · `salon_settings` (per-salon `dashboard_passcode_hash`, `payroll_passcode_hash`, `enforce_business_hours`, `enforce_technician_hours`) · `salon_hours` · `technicians` (`available_days[]` legacy/inert; `active`; `archived_at`) · `technician_services` (qualifications join table, no `salon_id` column) · `technician_hours` (day/hour availability, no `salon_id` column, `day_of_week` is text) · `technician_links` (locked read-only tokens) · `services` (`archived_at`, `display_order`) · `customers` (`source` constrained to `website`/`walk_in`/`phone`/`manual`/`referral`) · `bookings` (`booking_date`+`start_time`/`end_time`, `status`, `total_price`, `manage_token`, `created_by`), `booking_services` (no `salon_id` column) · `payments` · `payment_line_items` · `technician_time_off` (has its own `salon_id` column directly) · `email_logs` · `walkin_queue` (kiosk sign-ins; `party_size smallint NOT NULL DEFAULT 1`, CHECK 1–10; references `bookings` once converted) · `products`. **Website CMS tables:** `website_settings`, `website_gallery_images`, `service_category_images` (all salon-scoped, all with RLS policies) — see §14. **Payroll tables:** `technician_compensation`, `payroll_periods` (has own `salon_id`), `payroll_period_hours` (no `salon_id`, joins via `payroll_period_id`), `payroll_period_totals` (no `salon_id`, joins via `payroll_period_id`). **Rate limiting:** `rate_limit_counters` (generic, reusable — see §13).

**25 tables in `public`. Every one has RLS enabled** (verified July 28, 2026).

### 4.1 Wiping a salon's transactional data — correct delete order

Foreign keys make the order mandatory. `walkin_queue` references `bookings`, so it must be deleted **before** bookings:

```
payment_line_items → payments → booking_services → walkin_queue → bookings → customers
```

An earlier version of this doc listed `bookings` before `walkin_queue`. That order **fails** with a foreign key violation — confirmed in practice, and confirmed again on July 31, 2026 when a `walkin_queue` row (a cancelled walk-in-converted booking) blocked a `bookings` delete with `23503 ... violates foreign key constraint "walkin_queue_booking_id_fkey"`. The error is the safety net working: Postgres refuses the unsafe order rather than half-deleting, and it names the offending table.

**Red Persimmon's transactional state was reset to zero on July 31, 2026** (0 customers, 0 bookings, 0 walk-in queue rows, 0 payments) ahead of the Kristy handover. Configuration was untouched: 10 technicians, 67 active services. Four archived test technicians (`a1`, `a2`, `t1`, `t1`) were also hard-deleted after verifying zero references across all seven tables that point at `technicians` — an exception to the never-delete lifecycle rule, justified only because they held no history. **Real staff must be archived, never deleted.**

---

## 5. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- "No preference" assigns least-busy qualified technician; optionally checks real `technician_hours` window, gated by `enforce_technician_hours` (default off).
- `create_booking` validates every submitted service is real and active, server-side, regardless of caller.
- Customer emails via Make; token Manage page (`?manage=`) backed by `get_booking_by_token`/`cancel_booking_by_token` (anon-key, token-authorized, no salon scoping needed at that layer since the token itself is the authorization); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week, Insights, Customers, Payroll, Settings (all six sections), Aivy (Owner-Aivy — shallow, see §16), Admin/Walk-in Booking, Checkout & Payments.
- Owner Settings — Services, Staff, Website (Website: live "Test website sync" diagnostic, not stored state).
- Dashboard and website deployed together on Cloudflare Workers with GitHub auto-deploy — no manual file uploads.
- The dashboard authorization layer is live, deployed, and validated (§7).
- The Aivy chat widget's rate limiting + Turnstile bot protection is live, deployed, and validated (§13).
- Public booking is bot-protected end to end: the website books through the Turnstile-verified `booking-create` Edge Function, and `create_booking` is no longer executable with the public anon key (§8.2). Live and validated against production.

**Correction — this section previously said dashboard-managed website content was "not yet live." That is wrong.** The Website CMS is built and live; see §14 for what it covers and §14.3 for what remains unverified. Do not reintroduce a "CMS is unbuilt" claim here.

---

## 6. Security Model

### 6.1 Trust boundaries

Three structurally separate trust boundaries exist, and they must never be conflated:

1. **The public website** (`website.html`) — anon key, governed entirely by Postgres RLS policies for data reads. No Edge Function involvement for reads. The token-based Manage Appointment RPCs (`get_booking_by_token`, `cancel_booking_by_token`) are still called directly with the anon key — the unguessable token is itself the authorization, not RLS. **`create_booking` is no longer in this category.** As of July 31, 2026 its `EXECUTE` grant to `PUBLIC`/`anon`/`authenticated` is revoked; the only caller is the `booking-create` Edge Function, which carries its own independent boundary (Turnstile + salon/origin allowlist) — see §8.2. The Aivy chat widget on this same page calls `aivy-chat` (§13), which has its own independent security boundary (Turnstile + rate limiting + salon/origin allowlisting) — separate from both RLS and the dashboard's passcode model.
2. **The passcode-gated dashboard** (`dashboard.html`) — service-role key held server-side in two Edge Functions (`dashboard-read`, `dashboard-write`), never exposed to the client. RLS is irrelevant to this boundary (service-role bypasses it by design); **the Edge Functions themselves are the entire security boundary.**
3. **Owner-Aivy** (`owner-aivy`) — structurally different from both of the above: a single global passcode with no salon scoping at all. This is known, tracked technical debt (§16), not a frozen or endorsed design.

### 6.2 The dashboard vulnerability that was found and fixed

Both dashboard Edge Functions verified a caller's passcode against a claimed `salon_id`, then treated that verification as a boolean gate with no lasting effect — every read's table filter and every write's RPC arguments were still taken directly from the client's own request, unchecked against what had just been authenticated. A session that knew any one salon's passcode could read or write **any other salon's data** by simply changing the filter/argument values in the request, independent of which salon's passcode it had proven knowledge of.

**Confirmed live, not theoretically:** a session authenticated with Demo's passcode successfully read Red Persimmon's real bookings (22), customers (21), and payments (8) before the fix. Root cause: authentication and authorization were two disconnected steps — nothing bound the salon proven in step one to the data touched in step two.

### 6.3 The fix — centralized authorization layer

A single shared module, `_shared/authz.ts`, is now the sole authority for salon identity for the remainder of any dashboard request. Full detail in §7. Core properties:

- **Bind once, trust nowhere else.** `resolveAuthScope()` runs immediately after passcode verification and produces `AUTH_SCOPE`, the only salon identity that exists for the rest of the request. Client-supplied `salon_id`/`p_salon_id` values are never read again after this point — they are either overwritten (for arguments) or ignored entirely (for query filters).
- **Default-deny.** An unregistered table or action is rejected before any authorization logic runs.
- **Two-step ID resolution, no PostgREST embeds.** Ownership is resolved with plain `select`/`in()` queries, never PostgREST's `table!inner(...)` resource-embedding syntax — deliberately, for reliability and to avoid depending on foreign-key detection behavior.
- **Structured, internal-only reason codes.** Every authorization decision (`direct_ownership`, `inherited_ownership`, `salon_mismatch`, `entity_not_registered`, `record_not_found`, `no_owned_rows`, `missing_record_id`) is logged via `console.log`, never surfaced to the client.
- **`AUTH_SCOPE` is a `Set<string>`, not a scalar, from day one** — today it always holds exactly one salon id, but this means future multi-location support (one authenticated session legitimately spanning several salons under one owner) is a change to `resolveAuthScope()`'s return value only, never to the registries, resolvers, or either Edge Function's control flow.

### 6.4 Legacy passcode fallback — removed

The old no-`salon_id` fallback (checking against a single global `DASHBOARD_PASSCODE` environment variable) has been **fully removed** from `dashboard-read` and `dashboard-write`. `verifyPasscode()` now returns `false` immediately if no `salon_id` is provided — there is no code path left that can authenticate without identifying a specific salon.

### 6.5 Known residual risk, deliberately accepted for now

`_shared/authz.ts` is **duplicated identically into both Edge Functions**, not imported as a true shared module — see §16 for detail. Functionally verified identical and correct in both copies. **Any future change to the authorization logic must be applied to both files.**

---

## 7. Dashboard Authorization Architecture

### 7.1 Authentication flow

1. Client sends `{ salon_id, passcode, ...rest }` to `dashboard-read` or `dashboard-write`.
2. `resolveAuthScope(salon_id, passcode)`: calls `verifyPasscode()`, which calls the `verify_dashboard_passcode(p_salon_id, p_passcode)` RPC (per-salon hash comparison via `pgcrypto`). Returns `null` on any failure (missing `salon_id`, wrong passcode) → `401 unauthorized`.
3. On success, `resolveAuthScope` returns `new Set([salon_id])` — this is `AUTH_SCOPE`, and it is the only salon identity trusted for the rest of the request.
4. Payroll-gated tables/actions additionally require `verifyPayrollPin()` (independent of the dashboard passcode) before proceeding.

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

### 7.4 Read path (`dashboard-read`)

`buildScopedQuery(table, clientQuery, scope)`:
- `self` (`salons`): forces `id=eq.<scope>`, strips any client-supplied `id` filter.
- `direct`: strips any client-supplied filter on the salon column, injects `salonCol=eq.<scope>` (or `in.()` for a multi-salon future scope).
- `via`: if the client already narrows by the entity's own join key, that narrowing is **verified** with one bounded query (`id IN (requested ids) AND owned-by-scope`) rather than discarded. If the client sends no filter on the key at all, the full owned set is fetched.
- `select=` (PostgREST resource embedding) is always stripped.

### 7.5 Write path (`dashboard-write`)

For each action, `ACTION_REGISTRY` determines binding: `salonArg` → argument overwritten unconditionally; `recordBind` → `authorizeRecordBind()` resolves the record's true salon and compares to scope before the RPC is ever called.

### 7.6 Hardening found during self-review (fixed before deploy)

- **Prototype-chain lookup bypass:** `REGISTRY[key]` on a plain object walks the JS prototype chain — a `table`/`action` value of `"__proto__"` would return `Object.prototype` (truthy), defeating a naive `!REGISTRY[key]` check. Fixed with a `hasOwn()` helper used everywhere a registry is checked. (The same helper pattern is not needed in the rate limiter's RPC, §13, because that logic lives in Postgres/plpgsql, not JS object lookups.)
- **Query-building bug:** the original `via`-read design discarded any client-supplied join-key filter and always substituted the entire salon-owned id set — proven, with real data, this would have broken `payroll_period_totals`'s "view one period" behavior. Fixed by verifying the client's requested ids against ownership instead of overriding them.
- **Recursion depth guard:** `resolveSalonForEntity`'s chain-walk fails closed rather than hanging on a hypothetical future misconfigured cycle.
- **Unbounded read cost:** the query-building fix above also bounds cost to the client's own request size for the common case.

---

## 8. Booking Architecture

`create_booking(p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start, p_end, p_duration, p_price, p_notes, p_services, p_source default 'website', p_customer_id default null, p_created_by default null)` — single entry point for website + dashboard Admin Booking. Validates every submitted service is real and active, server-side, regardless of caller. `p_source` is constrained by `customers_source_check` to `website`/`walk_in`/`phone`/`manual`/`referral`.

`reschedule_booking(p_booking, p_date, p_start, p_tech default null)`, `mark_booking_status(p_booking, p_status, p_reason default null, p_by default 'salon')` (covers cancel/no-show/completed), `checkout_booking(p_booking, p_lines, p_payment_method, p_discount default 0, p_notes default null, p_created_by default null)` — `p_lines` requires `charged_price`, `tip_amount`, and a valid `technician_id` per line (not `price`/`quantity`). Internally calls `mark_booking_status(..., 'completed', ...)` on success.

### 8.1 Walk-in queue (kiosk)

`join_walkin_queue(p_salon_id, p_name, p_phone, p_email default null, p_requested_services default null, p_preferred_technician_id default null, p_party_size default 1)` — SECURITY DEFINER, `search_path` pinned, **granted to `anon`**. This is the kiosk's only write path, and because it is granted to `anon` it is reachable from the public internet with the publishable key, not just from the in-store tablet.

Validates: phone normalised to 10 digits (leading `1` stripped); email format if supplied; the preferred technician must belong to this salon and be active; every requested service must be real, active, unarchived, and belong to this salon. `party_size` defaults to 1 and is capped at 10 (`INVALID_PARTY_SIZE`), matching the table CHECK.

**Rate limited** via the generic `check_and_increment_rate_limit` RPC (§13) — no new tables. Two counters: per-person, keyed on the normalised phone (3 per 30 min), and per-salon as a circuit breaker (60 per hour). Since the limiter's `key_type` is constrained to session/ip/salon and a database function cannot see the caller's IP, the per-person budget uses `key_type = 'session'` with a `phone:` prefixed value. Over-limit raises `RATE_LIMITED`.

Note the per-person limit interacts with families sharing one phone number — `party_size` is the intended answer to that, not a higher limit.

`set_queue_status(p_salon_id, p_queue_id, p_status, p_booking_id)` — SECURITY DEFINER, granted to `service_role` only (dashboard path, never public).

**Website Manage Appointment (`?manage=<token>`):** `get_booking_by_token(p_token)` (read), `cancel_booking_by_token(p_token)` (the only mutation available from this surface). **"Reschedule" on the website calls the same `cancel_booking_by_token` RPC as "Cancel"**, then redirects to the booking flow — cancel-then-rebook by design, not atomic. Intentional, but see §16 item on product decision.

### 8.2 Public booking security — Turnstile gate + revoked public grant

**Status: COMPLETE, deployed (`booking-create` v1), validated live against production.** A real booking succeeded through the new path, and `has_function_privilege` confirms `anon` and `authenticated` can no longer execute `create_booking`.

**The problem.** Any visitor could read the publishable anon key out of the website source and call `create_booking` directly, repeatedly, from a script. One fake booking costs a single slot and is cancellable in two taps; an automated one could consume a salon's entire week. That second case was the only genuinely catastrophic abuse path, and it is what this closes.

**Design — layer 1 of a planned 3:**

- **`booking-create` is an auth gate, not a second validation layer.** Every booking business rule — service validity, availability, double-booking, business hours, technician assignment — stays in `create_booking`, unchanged. No booking logic moved.
- **Order of checks:** (1) `salon_id` allowlist plus a check that the request's `Origin` header matches that salon's known origin; (2) Turnstile verification; (3) only then, call `create_booking` with the service-role key.
- **A fresh Turnstile token per booking.** No trust token is minted or accepted here. A booking is a one-shot action, not a conversation, so §13's trust-token mechanism deliberately does not apply — reusing it would have added plumbing for no gain.
- **Client fields are whitelisted, never blind-passed.** Only the 11 fields the public form needs are forwarded. `p_salon` is overwritten with the validated `salon_id` and `p_source` is forced to `'website'`, so a caller cannot book into another salon, forge a source, or inject `p_customer_id`/`p_created_by`.
- **Error passthrough.** `create_booking`'s exception messages (`SLOT_TAKEN`, `NO_TECH_AVAILABLE`, `SALON_CLOSED`, `OUTSIDE_BUSINESS_HOURS`) are returned verbatim, so the website's existing customer-facing messages kept working with zero changes to them.
- **Fail-open vs. fail-closed — the same deliberate asymmetry as §13.** Cloudflare's siteverify unreachable → fail OPEN (log it, allow the booking). A token that is present but explicitly invalid → fail CLOSED. A broken safety check must never block real revenue.
- **Client-side fallback.** If no token can be obtained at all (script blocked, ad-blocker), the website throws `VERIFICATION_REQUIRED` and shows a message pointing at the salon's phone number — never a dead button, never a silently lost booking.

**The grant revoke — the part that actually closes it.** Turnstile on the form is theatre while the RPC stays publicly callable. Applied July 31, 2026:

```sql
REVOKE EXECUTE ON FUNCTION public.create_booking(
  uuid, text, text, text, uuid, date,
  time without time zone, time without time zone,
  integer, numeric, text, jsonb, text, uuid, text
) FROM PUBLIC, anon, authenticated;
```

ACL before: `=X/postgres | postgres | anon | authenticated | service_role`. After: `postgres | service_role`. The dashboard's Admin Booking is unaffected — `dashboard-write` holds the service-role key.

**Sequencing that must be repeated for every future salon:** deploy the website change and confirm a real booking works *before* revoking the grant. Reversed, every booking breaks instantly with no fallback. Rollback is a single `GRANT EXECUTE ... TO anon`.

**Residual risk, stated honestly.** A human with a fresh browser session, a VPN, and new fake details can still book one appointment at a time by hand. No booking system without a card hold prevents this — Square, Fresha, and GlossGenius all permit it (verified directly: a booking on Square's own flow with a fake number succeeded, with no sign-in and no card). Velour records payments rather than processing them, so a deposit or card-hold control is **structurally unavailable**, not merely unbuilt. The answer to the residual sliver is owner visibility and fast cancellation, not prevention — and that is the honest thing to tell a salon owner.

**Layers 2 and 3 — scoped, deliberately not built:**

- **Layer 2, rate limiting on booking.** The generic `check_and_increment_rate_limit` RPC (§13) already supports this with zero schema change; `booking-create` needs only to pass its own action name and limits. Deferred to keep this change small and independently testable, not because it isn't wanted.
- **Layer 3, per-identity open-booking cap.** Limit how many open future bookings one phone or email with no completed visit history may hold. Not built. Note its real limit: it is defeated by rotating identity, which is why it is ranked third rather than first.

Both are tracked in §16 as deferred, not forgotten.

---

## 9. Checkout & Payments Architecture

**Core model:** Expected Revenue = `bookings.total_price` (never overwritten at checkout); Actual Revenue = `payments.amount`; payroll/commission source of truth = `payment_line_items`. **Schema:** `payments` (header row per transaction) and `payment_line_items` (one row per service performed, `technician_id` NOT NULL, supports future correction via `voided_at`/`corrected_from_id`). **Explicitly deferred:** split/multi-tender payments, deposits, refunds/voids UI, gift cards, packages/memberships. RLS is enabled on both tables (no public policies — service-role access only).

---

## 10. Payroll Architecture

Live vs. Frozen model (effective-dated compensation history, close-and-open never overwrite). Schema: `technician_compensation`, `payroll_periods`, `payroll_period_hours`, `payroll_period_totals`. RPCs: `set_technician_compensation`, `create_payroll_period`, `update_payroll_hours` (requires all 7 days if updating `technician_hours` in the same session — a different RPC), `calculate_payroll_preview`, `close_payroll_period`. Payroll PIN gates both reads (via `PAYROLL_TABLES`) and writes (via `ACTION_REGISTRY`'s `payroll: true` flag), independently of the dashboard passcode.

---

## 11. Owner Settings & Salon Management Architecture

All six sections complete: Access & Security (dashboard passcode + Payroll PIN, both per-salon), Business Information, Business Hours (three-layer: weekly default, `salon_hours`, `enforce_business_hours`), Services (full CRUD, category-grouped, archive-blocked by future bookings, matched by *name* since `booking_services.service_id` is still unpopulated), Staff/Technicians (full CRUD, `technician_hours` is the source of truth for availability, qualifications via `technician_services`, deactivating never touches schedule links, only archiving does), Website (live sync-check diagnostic — **not** a CMS; see §14 for what that would actually require).

---

## 12. Website Architecture (current, hardcoded-content model)

Fully live-data for **booking-relevant** information (no hardcoded `TECH_DB`/`SVC_DUR`/`SALON_HRS`/`WIZARD_DATA`/`TECH_SERVICES` structures remain). A single `LIVE` object, fetched from Supabase on every page load, scoped by the deployment's hardcoded `SALON_ID` constant, with an honest all-or-nothing load gate (`dbGet()` throws on failure; nothing proceeds with partial data). `SALON_ID` genuinely is a `const` — any per-request salon override (used for Demo testing) must be done by passing an explicit id into `dbRpc()`/direct fetch calls, not by reassigning the constant.

**What is still hardcoded directly in `website/index.html`'s markup, not live-data-driven:** hero copy/imagery, About section, testimonials/reviews, promotions banner, gallery images, social links, SEO metadata. Some of this is currently placeholder/fake content (reviews, promotions) — see `NEXT_PROJECT_ROADMAP.md` items 2–3 for removal/replacement, and §14 below for the planned CMS that would eventually make this dashboard-editable instead of code-editable.

Booking-affecting surfaces confirmed reading live data end-to-end: main service grid, technician-specific modal, Aivy wizard, slot generation, Manage Appointment overlay (token-based, `?manage=`).

---

## 13. Aivy Chat Security Architecture — Rate Limiting & Turnstile

**Status: COMPLETE, deployed (`aivy-chat` v7), and browser-validated against production** — including a genuine 16th-message denial after the session limit was tuned from an initial 30 down to 15.

### 13.1 Design principles (frozen — see §17)

- **Generic rate limiter, not Aivy-specific.** One table (`rate_limit_counters`), one RPC (`check_and_increment_rate_limit`), reusable later for booking-spam or contact-form protection with zero schema changes — each future caller just passes its own action name and limits.
- **Layered identity model.** Turnstile proves "a real browser solved a challenge once"; a session counter is the primary per-conversation budget; a hashed-IP counter is the shared-network backstop; a salon-wide counter is the tenant-level circuit breaker. No single layer is sufficient alone.
- **Fixed-window counters**, not sliding — correctness comes from `window_start` being part of the composite primary key `(salon_id, action, key_type, key_value, window_start)`, never from a cleanup job having run. An expired-but-undeleted row is naturally ignored by a fresh window's lookup.
- **Signed trust token instead of a `session_trust` table.** After a Turnstile pass, the server mints an HMAC-signed, 25-minute token (session_id + salon_id + expiry). The client resends it on later messages; the server verifies it cryptographically — no DB lookup, no extra table, no cleanup job needed for this part.
- **Fail-open vs. fail-closed, intentionally asymmetric.** Turnstile unavailable → fail OPEN (log it, allow the message; the rate limiter is still the backstop). Rate limiter/Supabase unavailable → fail CLOSED (friendly fallback, never silently allow) — an error in the safety mechanism should never become "allow everything."
- **HMAC-SHA256, not plain hashing, for IPs in the counter table.** IPv4's small address space makes a plain hash trivially reversible via a precomputed table; HMAC with a server-only secret prevents that while staying deterministic.

### 13.2 Current limits

Owned in exactly one place — the `LIMITS` const inside `aivy-chat` itself. The generic RPC has no opinion on these numbers; they're passed as call-time arguments.

| Key | Window | Limit |
|---|---|---|
| session | 30 min | **15 messages** |
| ip (hashed) | 1 hour | 150 messages |
| salon | 24 hours | 1000 messages |
| Turnstile trust token lifetime | — | 25 min |

The session limit was originally 30, then deliberately lowered to 15 after a customer-experience review judged that the better balance between AI cost protection and a normal salon conversation. Changing it again is a one-line edit in `aivy-chat` — confirmed live during that change, nothing else needed touching.

### 13.3 Schema

`rate_limit_counters` — composite primary key `(salon_id, action, key_type, key_value, window_start)`, `key_type` constrained to `('session', 'ip', 'salon')`, `request_count` checked `> 0`. RLS enabled, zero policies (default-deny — only the service-role key, used inside Edge Functions, can touch it). No surrogate id column — the composite tuple is the identity. A `window_start` index supports cleanup independent of the PK index. No cleanup job is currently scheduled (see §16 — acceptable at current scale, revisit as a fast-follow if the table grows).

### 13.4 RPC

`check_and_increment_rate_limit(p_salon_id uuid, p_action text, p_checks jsonb) returns jsonb` — two-phase:
- **Phase A** validates all caller input with zero writes (bad action, malformed checks, duplicate key types) — an assertion layer, since `aivy-chat` is the only trusted caller today.
- **Phase B** is purely mechanical: UPSERT (`ON CONFLICT` on the composite key, which takes a row-level lock — this is what makes concurrent requests safe) → collect count via `RETURNING` → build response. No branching, no exception swallowing, so Postgres's automatic transaction rollback is the only consistency mechanism and it's never fought.

All checks in a call increment unconditionally before any allow/deny decision is made — a denied request still gets an accurate, logged count for every dimension, and no check's outcome depends on another check's position in the array. Returns:

```json
{
  "allowed": false,
  "checks": [
    { "key_type": "session", "current_count": 16, "limit": 15, "allowed": false },
    { "key_type": "ip", "current_count": 3, "limit": 150, "allowed": true }
  ]
}
```

Fully self-describing per check — no lossy top-level "first failure wins" reason.

### 13.5 `aivy-chat` request/response contract

Client sends: `{ messages, salon_id, session_id, turnstile_token? | trust_token? }`.

Server processes in order: (1) `salon_id` allowlist check against `SALON_ORIGINS`, plus a check that the calling `Origin` header matches that salon's known origin; (2) Turnstile verification (if `turnstile_token` sent) or trust-token verification (if `trust_token` sent) — exactly one of these two paths runs; (3) the three-tier rate-limit check; (4) only then, the Anthropic call.

Server returns: `{ reply, trust_token? }` normally, or `{ reply: <fallback>, require_turnstile: true }` when a trust token is missing/invalid/expired, or the same fallback with no `require_turnstile` flag when a rate limit is hit or the rate limiter itself is unavailable.

The client (`website/index.html` → `callClaude`) transparently retries once with a fresh Turnstile check on `require_turnstile`, invisible to the customer — confirmed live: a corrupted/expired token triggers exactly one Turnstile re-verification, then the real reply.

CORS is locked to recognized origins only (`Access-Control-Allow-Origin` is never `*` and never blindly reflects the request's `Origin` header — it's only ever set to a value found in `SALON_ORIGINS`).

### 13.6 Verified, not assumed

Every claim above was checked against live behavior: PK collision, CHECK constraints, RLS, and the cleanup index confirmed via direct SQL. The RPC's normal path, over-limit path, duplicate-key rejection, forced-failure rollback (proved a genuine mid-transaction abort rolls back everything, including a `CREATE FUNCTION` in the same batch), sequential concurrency (10 calls → counts 1–10, no lost updates), and stale-window correctness (a 2-hour-old row ignored without being deleted) were all live-tested. End-to-end browser runs against the live production site confirmed: first message with no visible Turnstile challenge, trust-token reuse (instrumented directly — 0 Turnstile calls on a reused token), token refresh (corrupted a real token, confirmed exactly 1 fresh Turnstile call and a transparent retry), the message limit at both 30 and, after the change, exactly 15 (message 16 denied, cross-checked against the database counter), and graceful failure when Turnstile is client-side unavailable (simulated ad-blocker/CDN-block scenario: instant fallback, no hang, full recovery on the next message).

### 13.7 Known, deliberately accepted trade-off

Turnstile is rendered lazily (on first message send, not on page load). Cloudflare recommends rendering as early as possible so the challenge is already resolved by the time it's needed; as built, a first-time visitor's very first message waits on that first challenge (typically under a second, occasionally longer under real network conditions). Functionally correct, no interaction required from the visitor — see `NEXT_PROJECT_ROADMAP.md` item 11 for the fast-follow fix (pre-render on chat-open instead of on send).

---

## 14. Website CMS (BUILT — dashboard-managed website content)

**Status: built and live.** Schema, dashboard UI, and save handlers all exist. This section previously described the CMS as a vision; that was wrong and is corrected here.

### 14.1 The problem it solved

Website content beyond live booking data was hardcoded directly in `website/index.html`. Every content change — a new promotion, an updated hero photo, a new testimonial — required an engineering change and a redeploy. That made Velour a permanent bottleneck for Kristy's day-to-day marketing, and structurally blocked onboarding a second salon.

### 14.2 What exists

A **Settings → Website** surface in the dashboard, with four sub-tabs:

- **Homepage**
- **Photos**
- **Contact & Social**
- **Google & Sharing** (SEO/share metadata)

Above the tabs sits a completion percentage and a plain-English checklist. The percentage is weighted: Homepage 40, Identity 20, Photos 20, Contact & Social 10, Search & Discovery 10.

**Backing tables:** `website_settings`, `website_gallery_images`, `service_category_images` — all salon-scoped with RLS policies, following the same discipline as every other dashboard-managed table.

### 14.3 Still to verify

How much of `website/index.html` now reads from these tables versus how much remains hardcoded markup. §12 has not been re-audited since the CMS shipped and should not be trusted on this point.

### 14.4 Non-goals, still holding

No page-builder/drag-and-drop editor, no theming system, no multi-page CMS. Structured fields only. Expand on real need, not speculatively.

---

## 15. Multi-Tenant Strategy (current state, consolidated)

Velour's stated long-term goal is "each salon is configuration, not custom code" (§1). Current state, honestly assessed:

**Already multi-tenant-ready:**
- Dashboard authorization layer (§7) — `AUTH_SCOPE` as a `Set`, `ENTITY_REGISTRY`/`ACTION_REGISTRY` pattern, fully salon-scoped by design.
- `aivy-chat`'s rate limiter and `SALON_ORIGINS` map (§13) — every counter is salon-scoped by construction; adding a second salon's Turnstile widget and origin is one map entry.
- Core booking/payments/payroll schema — every relevant table is either directly salon-scoped or scoped via a salon-scoped parent (§7.2's registry documents exactly which).

**Not yet multi-tenant-ready:**
- The website's non-booking content (§12, §14) — **partly resolved**: the Website CMS is built (§14), so content is now dashboard-managed rather than code-managed. How much of `website/index.html` still holds hardcoded markup has not been re-audited and must be confirmed before claiming this is fully closed.
- ~~Owner-Aivy — global passcode, no salon parameter~~ — **resolved** (§16 item 1); it is now per-salon scoped.
- The website and dashboard build itself — `SALON_ID`/`CONFIG.SALON_ID` are per-deployment constants baked in at build time, not runtime configuration. Onboarding a new salon today means a new build/deployment, not a new database row.

**The practical path to salon #2** (per `NEXT_PROJECT_ROADMAP.md` item 12) runs through §14 — the Website CMS is what turns "new salon = new deployment" into "new salon = new configuration."

---

## 16. Current Technical Debt (consolidated)

1. **Owner-Aivy briefing data is caller-supplied, not server-computed.** ~~Global passcode, no salon scoping~~ — **CLOSED July 28, 2026.** `owner-aivy` v4 verifies per-salon via the `verify_dashboard_passcode` RPC with an owner-role check, pulls the salon name from the database instead of hardcoding it, and locks CORS to the dashboard origin (verified correct). The remaining limitation: the briefing JSON is still supplied by the caller rather than independently computed server-side the way `aivy-chat` now builds its own facts. Lower exposure than the public chat since it is passcode-gated; worth doing when there is more than one dashboard-access person.
2. **The dashboard is a single shared passcode, not per-person accounts.** Everyone at the salon uses the same code; it cannot be revoked for one person, and it gates customers, revenue, and payroll. This is the highest *real-world* risk in the system for a live salon — higher than booking abuse — and the honest thing to tell an owner is to keep the code to herself and to say when someone leaves. Per-salon user accounts are the fix.
3. **Booking rate limiting (layer 2 of §8.2) not applied.** The generic RPC and table already exist; `booking-create` simply doesn't call them yet. Small, no schema change.
4. **Per-identity open-booking cap (layer 3 of §8.2) not built.** Would stop the lazy repeat-booker; defeated by identity rotation, so it ranks below layers 1 and 2.
5. **Double-`unlock()` freezes the dashboard tab.** Calling `unlock()` a second time without a page reload stacks overlapping `boot()`/`loadAll()` cycles with no in-flight guard. No known normal user path triggers this. Low priority.
6. **`_shared/authz.ts` duplicated, not truly shared** (§6.5) — both dashboard Edge Functions carry an identical inline copy.
7. **Website "Reschedule" is cancel-then-rebook, not atomic** (§8) — product decision needed on whether this should become a true reschedule-by-token RPC.
8. ~~**`payments`/`payment_line_items` RLS disabled**~~ — **CLOSED.** Verified July 28, 2026: both tables have RLS enabled, with no public policies, which is correct for service-role-only access. Every table in `public` now has RLS enabled.
9. **`mark_booking_status`'s cancellation-notify call not exception-guarded.**
10. **Business Hours conflict banner reads from `store.bookings` (always empty)** instead of `store.assembled` — root cause confirmed, fix proposed, not applied.
11. **Hardcoded origin allowlists are duplicated and fragile — now across three functions.** `aivy-chat` (`SALON_ORIGINS`), `owner-aivy` (`ALLOWED_ORIGIN`), and now `booking-create` (`SALON_ORIGINS`, a deliberate copy of Aivy's) each carry their own hardcoded copy of the deployment's origins. This has already caused one silent production outage (§18). Every new salon means editing every function holding a copy, and a mistake fails closed with no visible error to the owner. **This grew worse on July 31, 2026 and should be consolidated before salon two, not after.**
12. **Dev-mode flags can ship to production.** The dashboard's "View website" button pointed at a local dev file (`website_preview.html`) because `WS_DEV_MODE` was left `true` in a production deploy. Fixed July 28, 2026. Add "no dev-mode flags left enabled" to the pre-deploy checklist.
13. **One Demo sandbox booking has a cross-salon technician mismatch** (Kevin, a Red Persimmon technician, linked to a Demo booking) — sandbox-only, deliberately left alone.
14. **`close_salon_day` doesn't backfill time-off rows** for technicians added/reactivated after a closure.
15. **`booking_services.service_id` still not populated** by `create_booking` (name-matching used throughout instead).
16. **Website inline email/phone validation not built** (server already validates; UX polish item).
17. **Payment line item correction/void UI** — schema ready, nothing built.
18. **Stale booking-wizard state bug** on the website — pre-existing, not investigated.
19. **`aivy-chat` Turnstile renders lazily** on first message rather than on chat-open (§13.7) — minor first-message latency, not a correctness issue. Note `booking-create` has the same property by design and it matters less there: the visitor is already committing to a form submit, not typing a first message.
20. **No scheduled cleanup job for `rate_limit_counters`** — correctness doesn't depend on it (§13.3), but the table will grow unbounded without one. Acceptable at current traffic scale; revisit if it becomes a real cost/performance concern.
21. ~~**Website content is hardcoded per deployment**~~ — **SUPERSEDED.** The Website CMS is built and live (§14). Whatever content remains hardcoded is enumerated in §14, which is the single place to track it. Do not re-add a blanket "website content is hardcoded" claim here.

**Resolved, no longer debt:** the dashboard broken-access-control vulnerability (§6.2), and `aivy-chat` rate limiting/Turnstile (§13) — both formerly listed here, now complete.

---

## 17. Frozen Architectural Decisions

These decisions were reached through explicit design review and should not be relitigated without a genuinely new fact, not just renewed preference. If revisiting one, say so explicitly and explain what changed.

**Dashboard authorization (§6–7):**
- Centralized `ENTITY_REGISTRY`/`ACTION_REGISTRY` pattern over ad-hoc per-endpoint checks.
- `AUTH_SCOPE` as a `Set`, not a scalar, from day one — for future multi-location support without a redesign.
- Two-step ID resolution, never PostgREST embedded-resource filtering.
- Default-deny for unregistered tables/actions.
- `_shared/authz.ts` duplication across both Edge Functions accepted as a known trade-off rather than guessing at untested cross-function import behavior under time pressure (§6.5).

**Aivy chat security (§13):**
- Generic rate-limiter data shape (reusable for other endpoints later) — but explicitly **not** a generic configuration system; limits are hardcoded per-caller, not stored/edited via a settings table. This was a deliberate stop against over-engineering for a 5–10-salon stage.
- Layered defense (Turnstile + session counter + IP counter + salon counter) over any single control — no one layer was judged sufficient alone.
- Fixed-window over sliding-window counters — sliding window's precision isn't worth its implementation complexity at this scale; fixed window's known imprecision (edge-of-window bursts) is irrelevant for a backstop control, not a precision billing meter.
- Signed HMAC trust token over a `session_trust` database table — every new table is permanent maintenance; a cryptographic fact the server can re-verify itself doesn't need persistence.
- HMAC-SHA256 over plain hashing for IPs — plain hashing is reversible for the small IPv4 space via a precomputed table.
- Fail-open (Turnstile) vs. fail-closed (rate limiter) as a deliberate asymmetry, not an oversight — the bot-detection layer failing open costs nothing new; the budget-enforcement layer failing open would defeat the point of building it.
- **No analytics/conversation-history table was built.** Deliberately deferred — there's no proven question yet that such a table would answer, and speculative analytics tables become stale, privacy-sensitive maintenance burden. Build one only when Aivy improvement work (roadmap item 9) has a real question to ask of it.
- Session message limit lives in exactly one place (`LIMITS` const in `aivy-chat`) — validated in practice when it was changed from 30 to 15 with a single-line edit and no other file touched.

**Public booking security (§8.2):**
- **An Edge Function gate in front of `create_booking`, rather than validation inside the RPC.** The RPC already enforces every booking rule correctly; bot-detection is a different concern with a different failure mode and belongs at the edge, not mixed into business logic.
- **Revoking the public `EXECUTE` grant, not just adding Turnstile.** A gate that can be walked around is decoration. This was the deciding argument: half-closing it would have meant explaining a known bypass to a paying customer.
- **Fresh Turnstile token per booking; no trust token.** §13's trust token exists because a chat is many messages; a booking is one action. Reusing the mechanism would add plumbing and a reuse window for no benefit.
- **No temporary slot holds with a timed release.** Explicitly rejected during design. It would add a new booking state, require a cleanup job that does not exist, and create a new way for a real customer's slot to vanish mid-flow — multiplying the system's existing worst failure mode (cancel-then-rebook, §8). Rejected on risk, not effort.
- **No OTP / phone verification.** It proves a number exists, not that anyone will show up; it is blocked on A2P 10DLC registration regardless; and it introduces SMS-pumping cost exposure, converting an empty-chair problem into a billing problem. If Twilio capacity arrives, reminder texts (which raise revenue) come before verification texts (which lower conversion).
- **No deposits or card holds.** Not deferred — **structurally unavailable.** Velour records payments rather than processing them; a deposit control would require a processor integration, refund handling, and dispute exposure. Any future revisit is a business-model decision, not a feature.
- **Layered, in a deliberate order:** Turnstile (stops automation) → rate limits (stop speed) → identity caps (stop the lazy repeat). Ordered by ratio of abuse stopped to friction added, which is why the identity cap — the most obvious-sounding control — ranks last.

**Website / CMS (§14, forward-looking):**
- The CMS, when built, should follow the same salon-scoped-from-day-one discipline as §7 and §13 — the dashboard authorization retrofit was costly specifically because scoping wasn't designed in from the start; that mistake should not be repeated for the CMS.
- No page-builder or theming system — structured content fields only, scoped to the specific blocks in §14.2, expanded only on real need.

---

## 18. This Project's Process Notes (worth preserving)

- The dashboard vulnerability was found through targeted, adversarial code tracing prompted by a routine question about consistent authorization patterns — not through a scheduled audit. Worth remembering: "does every RPC actually check what it assumes it can trust" is a question worth asking proactively.
- Every claim of "verified" across both major projects meant one of: a live proof-of-concept against real Supabase data, a direct SQL reproduction of the exact query/RPC logic being deployed, or a real, connected browser driving the actual deployed system — never a claim based on reading code and reasoning about what it "should" do.
- The Aivy chat security project went through an unusually long, explicit design-review phase (identity model, atomicity, window semantics, hashing approach, indexing, time synchronization, starting limits) before any schema was written, and the design was revisited multiple times in response to direct challenges (separating rate limiting from analytics; dropping a planned `session_trust` table in favor of a signed token; refining the key-identity model; tightening the schema's constraints) — each revision was accepted only when it held up to "what abuse does this stop, what legitimate behavior might it block, is it sufficient alone." This back-and-forth materially improved the final design and is the intended way to use this working relationship, not a sign anything was wrong with the first draft.
- Two real deployment mistakes occurred during the dashboard authorization project and were caught before harm: a first `dashboard-read` deploy that accidentally sent placeholder content for the shared module (caught immediately, fixed by inlining), and a build-command filename mismatch during the Cloudflare Pages/Workers setup (caught via the build log, fixed by correcting the filename).
- During the Aivy chat security deployment, a real sequencing risk was caught before it caused a customer-facing outage: deploying the new `aivy-chat` before the frontend sent the new required fields would have silently degraded live chat to the fallback message for every customer. This was caught, and the two deploys were explicitly sequenced (frontend first, confirmed live, then the Edge Function) to close the gap to zero.
- Full regression matrices were executed against the **live deployed system** with a real connected browser in both major projects — not simulated.
- **Renaming a Cloudflare project silently breaks every hardcoded origin allowlist that references it.** After the Worker was renamed away from `velour-platform`, `aivy-chat`'s `SALON_ORIGINS` still pointed at the old domain. Because the origin check is a hard string match, **every customer chat message on the live site was rejected with a 403** — with no error visible to the owner — until it was found and corrected. Any future rename must be treated as a change to every function holding an origin constant.
- **A downloaded copy of a repo file may be behind `main`, and pushing it silently reverts work.** On July 31, 2026 an `index.html` was uploaded as "the current file" for patching. It contained the Website CMS work but *not* that morning's booking-security edits — while the live site was demonstrably booking through `booking-create`, proving `main` had them. Pushing that file would have reverted the change and, because the public grant was already revoked, broken **every** booking with no fallback. **Before pushing a replacement file, read the diff GitHub shows: if it removes anything you don't recognise, stop.** Prefer patching a file pulled fresh from `main` over one from a local downloads folder.
- **A foreign key error is the safety net working, and it names the fix.** During the July 31 test-data wipe, a `bookings` delete failed with `23503 ... walkin_queue_booking_id_fkey`. Nothing was half-deleted. The error identified the exact blocking table, and a single query against it found the cause: a delete step earlier in the sequence had been cancelled at the confirmation dialog rather than run. Read the constraint name before assuming the query is wrong.
- **Verifying a fix needs the right instrument.** Fetching the deployed site's HTML could not confirm whether a JavaScript change had shipped (the fetch sees pre-execution markup), and a first attempt to flag "missing" About copy was wrong for exactly this reason — the text was rendered live by the CMS. What did settle it: one real booking, then the Edge Function logs, then `has_function_privilege` for the permission claim. Match the instrument to the claim.
- **A stale source-of-truth document actively causes wrong decisions.** On July 28, 2026 this file wrongly listed Owner-Aivy's authentication as broken (fixed months earlier) and the Website CMS as unbuilt (shipped). Both led to real misdiagnosis in a working session before the live system was checked directly. Prefer checking the live system over trusting this document, and update it the same day a milestone lands.

---

## 19. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking or live customer-facing chat; validate JS/SQL before presenting; confirm before destructive actions. When two deployable pieces depend on each other, sequence them so there's never a window where the live system is broken, even briefly.

Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling, push back on scope creep even mid-project. One chat = one task where practical. Update this doc after milestones — as a patch against the actual current file when only fragments are available, never as a guessed full rewrite.

Every session should end with an updated `ARCHITECTURE.md`, an implementation handoff, and a new-chat starter prompt — see the companion documents delivered alongside this one.
