# Implementation Handoff — Velour

Covers the dashboard authorization fix, the Aivy chat security project, the Website CMS, and the July 28, 2026 maintenance session. `ARCHITECTURE.md` is the full source of truth; this handoff summarizes.

**Last verified against the live system: July 28, 2026.**

---

## Everything completed

**Dashboard broken-access-control fix:**
- Found and confirmed live a vulnerability where a session authenticated with one salon's passcode could read/write another salon's data.
- Built a centralized authorization layer (`_shared/authz.ts`, duplicated into both Edge Functions): `ENTITY_REGISTRY` (16 entities), `ACTION_REGISTRY` (28 actions), `AUTH_SCOPE` as a `Set`, default-deny, two-step ID resolution, structured internal logging.
- Removed the legacy global-passcode fallback entirely.
- Found and fixed four hardening issues during self-review before deploy (prototype-chain lookup bypass, a query-building bug that would have broken `payroll_period_totals`, an unbounded recursion risk, unbounded read cost).

**Aivy chat security (rate limiting + Turnstile):**
- Designed and built a generic, reusable rate limiter — one table (`rate_limit_counters`), one RPC (`check_and_increment_rate_limit`) — not Aivy-specific, deliberately kept that way through an extended design review. That reusability has since paid off: the walk-in queue now uses the same limiter with zero schema changes.
- Layered defense: Cloudflare Turnstile (invisible mode) + signed HMAC trust token (25-min, no database table) + three-tier rate limiting (session, hashed IP, salon-wide).
- Rewrote `aivy-chat`: salon_id allowlist, locked-down CORS (no more `*`), Turnstile/trust-token verification, rate limiting before any Anthropic call, fail-open on Turnstile outages / fail-closed on rate-limiter outages.
- Updated the website chat widget: session identity (sessionStorage), Turnstile integration, transparent token-refresh retry.
- Mid-project the session limit changed from 30 to 15 — confirmed to require exactly one line changed, validating the "single source of truth" design goal.

**Owner-Aivy per-salon authentication:**
- Replaced the single global `DASHBOARD_PASSCODE` check with per-salon verification via the `verify_dashboard_passcode` RPC, restricted to the owner role.
- Salon name now read from the database instead of the hardcoded "Kristy at Red Persimmon Nails & Spa".
- CORS locked to the dashboard origin (origin value re-verified correct on July 28, 2026).

**Website CMS:**
- Settings → Website surface with four sub-tabs (Homepage, Photos, Contact & Social, Google & Sharing), a weighted completion percentage and a plain-English checklist.
- Backed by `website_settings`, `website_gallery_images`, `service_category_images` — all salon-scoped with RLS policies.

**July 28, 2026 maintenance session:**
- **Aivy was quoting technician availability from a dead column.** `buildSystemPrompt` read `technicians.available_days`, which nothing writes to. Two technicians held `NULL`, so the `"Every day"` fallback told customers Ammu was available Monday–Thursday when she works Friday–Sunday only. Now reads `technician_hours`; the fallback admits uncertainty instead of inventing availability. Verified live on the production site for both affected technicians.
- **`WS_DEV_MODE` dev flag had shipped to production**, pointing the dashboard's "View website" button at a nonexistent local preview file. Fixed.
- **Rate limiting added to `join_walkin_queue`** — it is granted to `anon` and was previously unlimited, so the walk-in queue could be flooded from the public internet. Two counters via the existing limiter: per-phone (3 per 30 min) and per-salon (60 per hour). No new tables.
- **Walk-in party size** added end-to-end: `walkin_queue.party_size` column, RPC parameter, kiosk tap-selector, and a "party of N" chip on the dashboard (shown only when 2 or more).
- **`ARCHITECTURE.md` corrected** — it had drifted badly enough to cause real misdiagnosis during the session.
- **Red Persimmon's test data wiped** for a clean handover state.

## Deployment status

| Component | Status |
|---|---|
| `dashboard-read` | ACTIVE, live |
| `dashboard-write` | ACTIVE, live |
| `aivy-chat` | ACTIVE, live (15-message session limit; technician days from `technician_hours`) |
| `owner-aivy` | ACTIVE, live — per-salon auth, no longer legacy |
| `join_walkin_queue` / `set_queue_status` | live, rate-limited, party-size aware |
| `website/index.html` | live (Turnstile widget + chat identity logic) |
| `dashboard/velour-dashboard.html` | live (Website CMS, party-size chip) |
| `kiosk/index.html` | live (party-size selector) |
| `rate_limit_counters` table + RPC | live |

**Edge Function version numbers are deliberately not recorded.** They change on every deploy and a hand-maintained list always drifts — an earlier version of this document listed four functions at versions that were all wrong, and that stale list caused real misdiagnosis. Run `list_edge_functions` to see what is actually live.

Deployed via Supabase Edge Function deploys (backend) and GitHub push → Cloudflare Workers auto-deploy (frontend). **The website and dashboard are two separate Workers** (`velour-website` and `velour-dashboard`), not one. No manual file uploads to Cloudflare.

## Validation completed

Every project followed the same standard: "verified" means a live proof-of-concept against real Supabase data, a direct SQL reproduction of exact deployed logic, or a real connected browser driving the actual deployed system — never code-review-only.

**Dashboard authz:** vulnerability proven live before the fix (cross-salon read of real data), full regression matrix executed live post-fix with a real browser against Demo credentials — all PASS.

**Aivy chat security:** schema constraints verified via direct SQL. RPC verified for normal path, over-limit path, duplicate-key rejection, forced-failure transaction rollback, sequential concurrency, and stale-window correctness without cleanup. End-to-end browser validation covered first message, trust-token reuse, token refresh after simulated expiry, the message limit at both 30 and 15, and graceful failure when Turnstile is unavailable.

**Walk-in rate limiting:** exercised as an anonymous caller against the Demo salon — three joins allowed, fourth rejected with `RATE_LIMITED`, reformatted phone numbers (`(603) 555-0199`, `16035550199`) correctly caught as the same person, a different phone still allowed. Test rows removed.

**Party size:** a call omitting the field stores 1 (proving older clients keep working), a call with 4 stores 4, 11 is rejected with `INVALID_PARTY_SIZE`, and exactly one function overload exists. Confirmed end-to-end from the real kiosk through to the dashboard chip.

**Aivy technician days:** confirmed on the live production site after deploy — Ammu returns Friday/Saturday/Sunday, Alex returns Monday through Saturday.

## Known technical debt

See `ARCHITECTURE.md` §16 for the consolidated list. Highlights:

- **Hardcoded origin allowlists are duplicated** across `aivy-chat` and `owner-aivy`. This has already caused one silent production outage after a Cloudflare project rename — every customer chat message 403'd with no error visible to the owner. Every new salon means editing every function holding a copy.
- **Owner-Aivy's briefing data is caller-supplied**, not computed server-side the way `aivy-chat` builds its own facts. Lower exposure since it is passcode-gated, but worth closing once more than one person has dashboard access.
- `_shared/authz.ts` is duplicated across both dashboard Edge Functions, not a true shared import.
- No scheduled cleanup job for `rate_limit_counters` — correctness doesn't depend on it, but it grows unbounded.
- Aivy's Turnstile widget renders lazily on first message rather than on chat-open — minor latency, not a correctness issue.
- `technicians.available_days` still exists as a dead column. It should be **dropped**, not just documented as inert — documentation alone did not stop code from reading it.
- Dev-mode flags can reach production (`WS_DEV_MODE`). Add "no dev flags enabled" to the pre-deploy checklist.

**Closed since the last version of this document:** Owner-Aivy's global-passcode vulnerability; `payments`/`payment_line_items` RLS (every table in `public` now has RLS enabled); hardcoded website content (the CMS shipped).

## Operational notes

**Wiping a salon's transactional data — correct delete order.** Foreign keys make this mandatory; `walkin_queue` references `bookings`, so it must go first:

```
payment_line_items → payments → booking_services → walkin_queue → bookings → customers
```

An earlier documented order had `bookings` before `walkin_queue`. That order **fails** with a foreign key violation — confirmed in practice.

## Deferred items (explicit, not oversights)

- Conversation analytics/history for Aivy — deliberately not built; no proven question yet for it to answer.
- A true `session_trust` persistence layer — actively decided against in favour of a signed token.
- Split/multi-tender payments, deposits, refunds/voids UI, gift cards, packages/memberships.
- Time-in/flexible scheduling; multi-location beyond the `AUTH_SCOPE` groundwork already in place.
- **Group booking on the website.** Party size is kiosk-only by design. A website booking is a commitment against capacity — "party of 4" means four technicians and four slots simultaneously. Adding the field without the scheduling logic would reserve one technician and leave three people without a chair. Real group booking is multi-technician availability, combined duration, and one confirmation across several slots; that is a project, not a field.

## Next engineering priorities

See `NEXT_PROJECT_ROADMAP.md` for the ordered list. Immediate:

1. Confirm Red Persimmon's own passcode against the current deployment (~5 min, still not done).
2. Re-audit how much of `website/index.html` is still hardcoded now that the CMS exists — §12 of `ARCHITECTURE.md` has not been checked since.
3. Gather real salon photos from Kristy — still the highest-leverage remaining item, and not an engineering task.
4. Checkout and Payroll browser validation specifically against Red Persimmon, not just Demo.
5. Drop `technicians.available_days`.

**The real bottleneck is not engineering.** Red Persimmon is an unpaid pilot, formal handover has not happened, and pricing is unresolved. Proof and paying customers gate everything above.
