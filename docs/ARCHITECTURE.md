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

- **Website** — static `index.html` (deliverable file name: `website.html`). Deployed via **Cloudflare Workers, static assets, GitHub-integrated auto-deploy** (repo: `saikumar761997/velour-platform`, branch `main`; build command assembles `website/index.html` → `public/index.html` and `dashboard/velour-dashboard.html` → `public/dashboard.html`; every push to `main` redeploys automatically). Live at `https://velour-platform.redpersimmon.workers.dev/`. Calls Supabase **directly** with the anon key via a generic `dbGet()`/`dbRpc()` helper — no Edge Function proxy on this side, protected by permissive public RLS policies on `salons`, `services`, `technicians`, `salon_hours`, `technician_hours`, `technician_services`. `dbGet()` throws on any failure instead of silently returning `[]` (honest all-or-nothing load gate). Also embeds the Aivy chat widget (§13).
- **Dashboard** — static `velour-dashboard.html` (deliverable file name: `dashboard.html`), served at `/dashboard.html` on the same Worker as above. Per-salon passcode-gated. `CONFIG.SALON_ID` is a hardcoded per-deployment constant (this deployment: Red Persimmon) — the frontend is single-tenant per build; multi-tenancy lives entirely in the backend authorization layer (§7).
- **Supabase project:** `hydhezpeuhqhcugnpupu`. Red Persimmon salon id `a0000000-0000-0000-0000-000000000001`. Demo salon id `d0000000-0000-0000-0000-000000000001` (permanent sandbox, safe to wipe/reseed anytime).
- **Edge Functions (current deployed versions as of this update):** `dashboard-read` (v17), `dashboard-write` (v25) — both rewritten in the dashboard authorization project, see §7. `owner-aivy` (v3) — unchanged, separate legacy auth, see §16 Technical Debt. `aivy-chat` (v7) — customer-facing website assistant, rate limiting + Turnstile added this update, see §13.
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
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work. Enforced architecturally in the dashboard authz layer (§7) and in `aivy-chat`'s `SALON_ORIGINS` map (§13); **not yet true of the website's content**, which is still hardcoded per deployment — see §14.
- **Lifecycle model:** `active` boolean = reversible; `archived_at` = permanent, requires already-inactive; never delete; archive blocked by future confirmed bookings. Used identically by Services and Staff (technicians).
- **Rate-limiter counting model:** fixed-window counters, keyed by `(salon_id, action, key_type, key_value, window_start)` — correctness comes from the window being part of the key, never from a cleanup job having run. See §13.

---

## 4. Database (key tables)

`salons` · `salon_settings` (per-salon `dashboard_passcode_hash`, `payroll_passcode_hash`, `enforce_business_hours`, `enforce_technician_hours`) · `salon_hours` · `technicians` (`available_days[]` legacy/inert; `active`; `archived_at`) · `technician_services` (qualifications join table, no `salon_id` column) · `technician_hours` (day/hour availability, no `salon_id` column, `day_of_week` is text) · `technician_links` (locked read-only tokens) · `services` (`archived_at`, `display_order`) · `customers` (`source` constrained to `website`/`walk_in`/`phone`/`manual`/`referral`) · `bookings` (`booking_date`+`start_time`/`end_time`, `status`, `total_price`, `manage_token`, `created_by`), `booking_services` (no `salon_id` column) · `payments` (no RLS — see §16) · `payment_line_items` (no RLS — see §16) · `technician_time_off` (has its own `salon_id` column directly) · `email_logs`. **Payroll tables:** `technician_compensation`, `payroll_periods` (has own `salon_id`), `payroll_period_hours` (no `salon_id`, joins via `payroll_period_id`), `payroll_period_totals` (no `salon_id`, joins via `payroll_period_id`). **Rate limiting:** `rate_limit_counters` (generic, reusable — see §13).

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

**Not yet live** — see §14: any dashboard-managed website content (hero image, gallery, testimonials, promotions, homepage copy, social links, SEO metadata). All website content today is hardcoded in `website/index.html` itself, including some placeholder/fake content (reviews, promotions) slated for removal — see `NEXT_PROJECT_ROADMAP.md`.

---

## 6. Security Model

### 6.1 Trust boundaries

Three structurally separate trust boundaries exist, and they must never be conflated:

1. **The public website** (`website.html`) — anon key, governed entirely by Postgres RLS policies for data reads. No Edge Function involvement for reads. `create_booking` and the token-based Manage Appointment RPCs (`get_booking_by_token`, `cancel_booking_by_token`) are called directly with the anon key; their own internal logic (or, for tokens, the unguessable token itself) is the security boundary, not RLS. The Aivy chat widget on this same page calls `aivy-chat` (§13), which has its own independent security boundary (Turnstile + rate limiting + salon/origin allowlisting) — separate from both RLS and the dashboard's passcode model.
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

**Website Manage Appointment (`?manage=<token>`):** `get_booking_by_token(p_token)` (read), `cancel_booking_by_token(p_token)` (the only mutation available from this surface). **"Reschedule" on the website calls the same `cancel_booking_by_token` RPC as "Cancel"**, then redirects to the booking flow — cancel-then-rebook by design, not atomic. Intentional, but see §16 item on product decision.

---

## 9. Checkout & Payments Architecture

**Core model:** Expected Revenue = `bookings.total_price` (never overwritten at checkout); Actual Revenue = `payments.amount`; payroll/commission source of truth = `payment_line_items`. **Schema:** `payments` (header row per transaction) and `payment_line_items` (one row per service performed, `technician_id` NOT NULL, supports future correction via `voided_at`/`corrected_from_id`). **Explicitly deferred:** split/multi-tender payments, deposits, refunds/voids UI, gift cards, packages/memberships. **Known gap:** RLS disabled on both tables (§16).

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

## 14. Version 2 Architecture — Website CMS (VISION, NOT YET BUILT)

**Everything in this section is planned, not implemented.** No schema, RPCs, or dashboard UI exist for any of this yet. It's documented here so the eventual design work starts from a clear picture of the problem, not from scratch — but nothing below should be treated as a current capability.

### 14.1 Why this is needed

Today, all website content beyond live booking data (§12) is hardcoded directly in `website/index.html`. Every content change — a new promotion, an updated hero photo, a new testimonial — requires an engineering change and a redeploy. This has two costs: it makes Velour (the team) a permanent bottleneck for Kristy's day-to-day marketing, and it structurally blocks onboarding a second salon, since "configuration, not custom code" (§1) doesn't hold for the website at all today.

### 14.2 Planned scope (per `NEXT_PROJECT_ROADMAP.md` item 8)

A new dashboard surface, likely under Owner Settings, managing:

- Hero image
- About section
- Homepage content (general copy blocks)
- Gallery management
- Testimonials
- Promotions
- Social links
- SEO metadata

### 14.3 Design questions to resolve before any implementation (not yet answered)

- **Storage model:** likely a new `salon_website_content` table (or similar), salon-scoped like every other dashboard-managed table — following the same `ENTITY_REGISTRY` pattern from §7 rather than inventing a new authorization approach.
- **Rendering model:** does the website fetch this content live (same pattern as `LIVE` object in §12), or does publishing trigger a rebuild/redeploy? Live-fetch is more consistent with the current architecture and avoids a build-pipeline dependency, but needs a decision on caching/staleness.
- **Media storage:** hero images, gallery photos, and any uploaded media need a storage strategy (Supabase Storage is the natural default given the rest of the stack, but unconfirmed/undecided).
- **Multi-tenant path:** this is the component that actually determines whether "prepare Velour for onboarding additional salons" (roadmap item 12) is achievable — the CMS should be designed salon-scoped from day one, not retrofitted later, given how costly that retrofit was for the dashboard authorization layer (§6).

### 14.4 Explicit non-goals for the first version of this work

Following this project's own feature-filter discipline: no page-builder/drag-and-drop editor, no theming system, no multi-page CMS (the website is a single page today) — just structured, dashboard-editable fields for the specific content blocks listed in §14.2. Expand scope only if a real need arises, not speculatively.

---

## 15. Multi-Tenant Strategy (current state, consolidated)

Velour's stated long-term goal is "each salon is configuration, not custom code" (§1). Current state, honestly assessed:

**Already multi-tenant-ready:**
- Dashboard authorization layer (§7) — `AUTH_SCOPE` as a `Set`, `ENTITY_REGISTRY`/`ACTION_REGISTRY` pattern, fully salon-scoped by design.
- `aivy-chat`'s rate limiter and `SALON_ORIGINS` map (§13) — every counter is salon-scoped by construction; adding a second salon's Turnstile widget and origin is one map entry.
- Core booking/payments/payroll schema — every relevant table is either directly salon-scoped or scoped via a salon-scoped parent (§7.2's registry documents exactly which).

**Not yet multi-tenant-ready:**
- The website's non-booking content (§12, §14) — hardcoded per deployment, the single largest blocker to onboarding salon #2 without a bespoke engineering pass.
- Owner-Aivy (§16) — global passcode, no salon parameter at all, structurally single-tenant.
- The website and dashboard build itself — `SALON_ID`/`CONFIG.SALON_ID` are per-deployment constants baked in at build time, not runtime configuration. Onboarding a new salon today means a new build/deployment, not a new database row.

**The practical path to salon #2** (per `NEXT_PROJECT_ROADMAP.md` item 12) runs through §14 — the Website CMS is what turns "new salon = new deployment" into "new salon = new configuration."

---

## 16. Current Technical Debt (consolidated)

1. **Owner-Aivy authentication is separate, legacy, and single-tenant.** `owner-aivy` Edge Function checks `passcode !== DASHBOARD_PASSCODE` (a single global env var) with no `salon_id` parameter at all. Its system prompt is also hardcoded to `"Kristy at Red Persimmon Nails & Spa"`. Needs its own design project, same rigor as the dashboard authorization and Aivy-chat security work.
2. **Double-`unlock()` freezes the dashboard tab.** Calling `unlock()` a second time without a page reload stacks overlapping `boot()`/`loadAll()` cycles with no in-flight guard. No known normal user path triggers this. Low priority.
3. **`_shared/authz.ts` duplicated, not truly shared** (§6.5) — both dashboard Edge Functions carry an identical inline copy.
4. **Website "Reschedule" is cancel-then-rebook, not atomic** (§8) — product decision needed on whether this should become a true reschedule-by-token RPC.
5. **`payments`/`payment_line_items` RLS disabled** — every other sensitive table has RLS with no public policies; these two are the exception (mitigated by both only ever being touched via service-role Edge Functions, but not a substitute for RLS).
6. **`mark_booking_status`'s cancellation-notify call not exception-guarded.**
7. **Business Hours conflict banner reads from `store.bookings` (always empty)** instead of `store.assembled` — root cause confirmed, fix proposed, not applied.
8. **One Demo sandbox booking has a cross-salon technician mismatch** (Kevin, a Red Persimmon technician, linked to a Demo booking) — sandbox-only, deliberately left alone.
9. **`close_salon_day` doesn't backfill time-off rows** for technicians added/reactivated after a closure.
10. **`booking_services.service_id` still not populated** by `create_booking` (name-matching used throughout instead).
11. **Website inline email/phone validation not built** (server already validates; UX polish item).
12. **Payment line item correction/void UI** — schema ready, nothing built.
13. **Stale booking-wizard state bug** on the website — pre-existing, not investigated.
14. **`aivy-chat` Turnstile renders lazily** on first message rather than on chat-open (§13.7) — minor first-message latency, not a correctness issue.
15. **No scheduled cleanup job for `rate_limit_counters`** — correctness doesn't depend on it (§13.3), but the table will grow unbounded without one. Acceptable at current traffic scale; revisit if it becomes a real cost/performance concern.
16. **Website content is hardcoded per deployment, not dashboard-managed** — the core problem §14 (Website CMS) exists to solve. Includes some currently-placeholder content (fake reviews, promotions) slated for removal per `NEXT_PROJECT_ROADMAP.md`.

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

---

## 19. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking or live customer-facing chat; validate JS/SQL before presenting; confirm before destructive actions. When two deployable pieces depend on each other, sequence them so there's never a window where the live system is broken, even briefly.

Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling, push back on scope creep even mid-project. One chat = one task where practical. Update this doc after milestones — as a patch against the actual current file when only fragments are available, never as a guessed full rewrite.

Every session should end with an updated `ARCHITECTURE.md`, an implementation handoff, and a new-chat starter prompt — see the companion documents delivered alongside this one.
