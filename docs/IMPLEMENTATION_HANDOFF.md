# Implementation Handoff — Velour

Covers everything completed through the dashboard authorization fix and the Aivy chat security project. Both are complete, deployed, and frozen (see `ARCHITECTURE.md` §17). This handoff summarizes; `ARCHITECTURE.md` is the full source of truth.

---

## Everything completed

**Dashboard broken-access-control fix:**
- Found and confirmed live a vulnerability where a session authenticated with one salon's passcode could read/write another salon's data.
- Built a centralized authorization layer (`_shared/authz.ts`, duplicated into both Edge Functions): `ENTITY_REGISTRY` (16 entities), `ACTION_REGISTRY` (28 actions), `AUTH_SCOPE` as a `Set`, default-deny, two-step ID resolution, structured internal logging.
- Removed the legacy global-passcode fallback entirely.
- Found and fixed four hardening issues during self-review before deploy (prototype-chain lookup bypass, a query-building bug that would have broken `payroll_period_totals`, an unbounded recursion risk, unbounded read cost).

**Aivy chat security (rate limiting + Turnstile):**
- Designed and built a generic, reusable rate limiter — one table (`rate_limit_counters`), one RPC (`check_and_increment_rate_limit`) — not Aivy-specific, deliberately kept that way through an extended design review.
- Layered defense: Cloudflare Turnstile (invisible mode) + signed HMAC trust token (25-min, no database table) + three-tier rate limiting (session, hashed IP, salon-wide).
- Rewrote `aivy-chat`: salon_id allowlist, locked-down CORS (no more `*`), Turnstile/trust-token verification, rate limiting before any Anthropic call, fail-open on Turnstile outages / fail-closed on rate-limiter outages.
- Updated `website/index.html`'s chat widget: session identity (sessionStorage), Turnstile integration, transparent token-refresh retry.
- Mid-project, the session limit was changed from 30 to 15 after a customer-experience review — confirmed to require exactly one line changed, validating the "single source of truth" design goal.

## Deployment status

| Component | Status |
|---|---|
| `dashboard-read` | v17, ACTIVE, live |
| `dashboard-write` | v25, ACTIVE, live |
| `aivy-chat` | v7, ACTIVE, live (includes 15-message session limit) |
| `owner-aivy` | v3, ACTIVE, live — **unchanged legacy**, not part of either completed project |
| `website/index.html` | live, includes Turnstile widget + updated chat identity logic |
| `dashboard/velour-dashboard.html` | live, unchanged by the Aivy security project |
| `rate_limit_counters` table + RPC | live, deployed via migration |

All deployed via Supabase Edge Function deploys (backend) and GitHub push → Cloudflare Workers auto-deploy (frontend). No manual file uploads to Cloudflare.

## Validation completed

Both projects followed the same standard: "verified" means a live proof-of-concept against real Supabase data, a direct SQL reproduction of exact deployed logic, or a real connected browser driving the actual deployed system — never code-review-only.

**Dashboard authz:** vulnerability proven live before the fix (cross-salon read of real data), full regression matrix executed live post-fix with a real browser against Demo credentials (dashboard data, CRUD, booking lifecycle, Settings, website booking flow — all PASS).

**Aivy chat security:** schema constraints (PK collision, CHECK constraints, RLS, cleanup index) verified via direct SQL. RPC verified for: normal path, over-limit path, duplicate-key rejection, forced-failure transaction rollback (proved a genuine mid-transaction abort rolls back everything including a `CREATE FUNCTION` in the same batch), sequential concurrency, and stale-window correctness without cleanup. End-to-end browser validation against the live production site covered: first message (no visible challenge), trust-token reuse (instrumented directly, confirmed zero Turnstile calls), token refresh after simulated expiry (confirmed exactly one fresh Turnstile call, transparent retry), the message limit at both 30 and, after the change, 15 (message 16 denied, cross-checked against the database counter), and graceful client-side failure when Turnstile is unavailable.

## Known technical debt

See `ARCHITECTURE.md` §16 for the full consolidated list (16 items). Highlights:

- Owner-Aivy's authentication is separate, legacy, single-tenant (global passcode, no `salon_id`) — same vulnerability class as the dashboard fix, not yet applied here.
- `_shared/authz.ts` is duplicated across both dashboard Edge Functions, not a true shared import.
- `payments`/`payment_line_items` RLS is disabled (mitigated by service-role-only access, not a substitute for RLS).
- No scheduled cleanup job exists yet for `rate_limit_counters` — correctness doesn't depend on it, but it will grow unbounded without one eventually.
- Aivy's Turnstile widget renders lazily on first message rather than on chat-open — minor first-message latency, not a correctness issue.
- Website content (hero, gallery, testimonials, promotions, About, social links, SEO) is hardcoded per deployment — the core problem the planned Website CMS (`ARCHITECTURE.md` §14) exists to solve.

## Deferred items (explicit, not oversights)

- Conversation analytics/history for Aivy — deliberately not built; no proven question yet for it to answer. Revisit when post-launch usage data creates a real need (roadmap item 9).
- A true `session_trust` persistence layer — deliberately replaced with a signed token instead; not deferred, actively decided against.
- Split/multi-tender payments, deposits, refunds/voids UI, gift cards, packages/memberships — real future work, not urgent.
- Time-in/flexible scheduling, multi-location support beyond the `AUTH_SCOPE` groundwork already in place.

## Next engineering priorities

See `NEXT_PROJECT_ROADMAP.md` for the full, ordered list with complexity/dependencies/timing. Immediate next steps:

1. Confirm Red Persimmon's own passcode against the current deployment (trivial, ~5 min, still not done).
2. Remove fake website content (reviews, promotions, placeholder images) — launch-blocking honesty issue, not cosmetic.
3. Gather real salon photos from Kristy — blocks both item 2 and the eventual premium redesign.
4. Final production audit + Checkout/Payroll browser validation, specifically against Red Persimmon (not just Demo).
5. `payments`/`payment_line_items` RLS gap — real security hardening, recommended before/at launch.

After launch readiness: the conversion-focused website redesign, then the Website CMS (the largest single item on the roadmap — expect its own multi-session design review before any schema work, same rigor as both completed security projects).
