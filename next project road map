# Velour — Next Project Roadmap

Ordered by business value and launch readiness, per the project's own feature filter (salon revenue, owner workload, customer experience). Every item includes priority, business value, complexity, dependencies, and recommended timing.

---

## LAUNCH — must happen before/at go-live with Kristy

### 1. Confirm Red Persimmon's own passcode against the current deployment
**Priority:** P0
**Business value:** closes the one untested gap between "validated on Demo" and "confirmed working for the actual paying client."
**Complexity:** trivial (~5 minutes).
**Dependencies:** none.
**Timing:** Launch.

### 2. Remove all fake website content
**Priority:** P0
**Business value:** directly protects trust and conversion — placeholder reviews, fake promotions, and stock/placeholder imagery are a credibility risk the moment a real customer looks closely. This is not cosmetic; it's a launch-blocking honesty issue.
**Complexity:** small — content removal, no new engineering. Some sections (reviews, gallery) will go temporarily empty or need a "coming soon" treatment until item 3 supplies real content.
**Dependencies:** should land before or alongside item 3 (real photos) so the site isn't briefly emptier than it needs to be.
**Timing:** Launch.

### 3. Gather real salon photos from Kristy
**Priority:** P0
**Business value:** required input for item 2 (replacing placeholders) and item 4 (premium redesign) — no amount of engineering substitutes for real photos of the actual salon, work, and space.
**Complexity:** small for Velour (receiving/organizing files); depends on Kristy's time to shoot or provide them — the real bottleneck is scheduling, not engineering.
**Dependencies:** none technically; blocks items 2 and 4 from being fully finished.
**Timing:** Launch.

### 4. Complete final production audit
**Priority:** P0
**Business value:** the last checkpoint before calling the system genuinely ready for Kristy's real, unsupervised daily use — catches anything the individual project-by-project validation (dashboard authz, Aivy security, etc.) might have missed in combination.
**Complexity:** medium — a real, connected-browser regression pass across booking, checkout, payroll, settings, and the Aivy chat flow together, specifically against Red Persimmon (not just Demo).
**Dependencies:** item 1 (need working RP credentials).
**Timing:** Launch.

### 5. Browser-validate Checkout and Payroll end-to-end for Red Persimmon
**Priority:** P0
**Business value:** real money flows — backend RPC-tested and Demo-validated already, but never click-tested against the production salon specifically.
**Complexity:** small — repeats an already-proven regression technique against Red Persimmon instead of Demo.
**Dependencies:** item 1.
**Timing:** Launch. (May be folded into item 4's audit rather than run separately.)

### 6. `payments`/`payment_line_items` RLS gap
**Priority:** P1
**Business value:** real security hardening (defense in depth) on the two tables handling actual revenue data. Currently mitigated by both only being touched via service-role Edge Functions, but that's not a substitute for RLS on tables holding financial and customer data.
**Complexity:** medium — needs a deliberate, careful pass since existing read/write flows depend on the current unrestricted state; not a blind "enable RLS" toggle.
**Dependencies:** none, but do with dedicated focus.
**Timing:** Launch (strongly recommended before real customer payment data accumulates further) or immediate post-launch fast-follow at the latest.

---

## VERSION 2 — the conversion/premium-experience phase

### 7. Redesign the website to feel premium and increase booking conversion
**Priority:** P1
**Business value:** direct revenue lever — conversion rate on the booking flow is the single highest-leverage thing standing between traffic and revenue for an already-functioning system. This is the first work where Velour is competing on experience quality, not just functionality.
**Complexity:** medium-large — visual/UX redesign work, informed by real photos (item 3) and with fake content already removed (item 2).
**Dependencies:** items 2 and 3.
**Timing:** Version 2.

### 8. Website CMS inside the dashboard
**Priority:** P1
**Business value:** removes Velour (the team) as a bottleneck for every content change Kristy wants to make — directly reduces owner workload (the project's own feature filter) and is the necessary foundation for onboarding salon #2, since hardcoded-per-deployment website content doesn't scale past one salon.
**Complexity:** large — genuinely new dashboard surface, new schema, new website rendering path. Needs its own design review before implementation, same rigor as the dashboard authorization and Aivy security projects. Scope, in order of likely build sequence:
  - Hero image
  - About section
  - Homepage content (general copy blocks)
  - Gallery management
  - Testimonials
  - Promotions
  - Social links
  - SEO metadata
**Dependencies:** item 7 (design direction should inform what the CMS needs to support, not the reverse) and conceptually related to item 12 (multi-tenant readiness) — this is the piece that turns "hardcoded website per salon" into "configuration, not custom code."
**Timing:** Version 2. This is the single largest item on this roadmap — expect it to be its own multi-session project with a full design review before any schema work, per this project's established working style.

---

## FAST FOLLOWS — after live, guided by real usage

### 9. Improve Aivy using real customer conversations
**Priority:** P2
**Business value:** Aivy's system prompt and behavior were designed pre-launch, without real customer question patterns. Post-launch conversation data is the actual signal for what to improve — analytics/history explicitly deferred until there's a real question to answer (see ARCHITECTURE.md's rate-limiter design notes).
**Complexity:** medium — likely needs a lightweight conversation-analytics table (deliberately not built yet — see Frozen Decisions in ARCHITECTURE.md) plus prompt iteration.
**Dependencies:** real launch traffic. Not worth starting before Kristy is live.
**Timing:** Fast follow, post-launch.

### 10. Owner-Aivy authentication redesign
**Priority:** P2
**Business value:** currently a real security gap (global passcode, no salon scoping) — same vulnerability class as the dashboard authorization issue that was found and fixed, just not yet applied here. Also structurally blocks Owner-Aivy from ever working for a second salon.
**Complexity:** medium — needs the same architectural rigor as the dashboard authorization project (design review before code), but the underlying pattern is now a proven, reusable template. Also involves a product decision: does the system prompt become salon-aware instead of hardcoding "Kristy at Red Persimmon," and does the dashboard client need to start sending `salon_id`.
**Dependencies:** none technically, but should reuse the `ENTITY_REGISTRY`/`AUTH_SCOPE` pattern conceptually.
**Timing:** Fast follow. Worth prioritizing above pure feature work given it's a real, known security gap, not just debt.

### 11. Aivy chat first-message Turnstile latency
**Priority:** P3
**Business value:** low — UX nicety, not a bug. Turnstile currently renders lazily on first message send rather than on chat-open, so a first-time visitor's first message can wait on the initial challenge.
**Complexity:** small — pre-render the widget on chat-open instead of on send.
**Dependencies:** none.
**Timing:** Fast follow.

### 12. Prepare Velour for onboarding additional salons
**Priority:** P2
**Business value:** the actual stage goal (5–10 paying salons) depends on this — every hardcoded-per-deployment piece (website `SALON_ID` constant, per-salon Turnstile widget, per-deployment build) needs a repeatable onboarding path before salon #2 can go live without a bespoke engineering pass each time.
**Complexity:** large, but mostly assembly of already-proven pieces: the dashboard authorization layer, `aivy-chat`'s `SALON_ORIGINS` map, and the rate limiter are all already salon-scoped/multi-tenant-ready by design. The real gap is the **website** and **CMS** (items 7–8) — until content is dashboard-managed instead of hardcoded per build, a second salon means a second codebase fork, not configuration.
**Dependencies:** item 8 (Website CMS) is the real blocker here — this item is largely "the payoff of item 8," not separate engineering.
**Timing:** Future, gated on Version 2 (item 8) being substantially complete.

### 13. Consolidate `_shared/authz.ts` into a true shared module
**Priority:** P3
**Business value:** pure maintainability. Functionally correct today (both copies verified identical), but every future authorization change requires remembering to edit both files.
**Complexity:** small — either verify the correct relative-import path convention (testable via a Supabase database branch first) or formally accept duplication with a lint/diff check that fails CI if the two copies diverge.
**Dependencies:** none.
**Timing:** Fast follow / Future.

### 14. Double-`unlock()` tab-freeze fix
**Priority:** P3
**Business value:** low — no known normal user path triggers it.
**Complexity:** small — add an in-flight guard to `boot()`/`loadAll()`.
**Dependencies:** none.
**Timing:** Future.

### 15. Website "Reschedule" atomicity
**Priority:** P3
**Business value:** low-medium — real but narrow customer-experience risk (losing a slot mid-reschedule). Needs a product decision first, not just an engineering fix.
**Complexity:** medium if it becomes a true `reschedule_booking_by_token` RPC; small if the decision is instead to improve messaging/flow around the existing cancel-then-rebook behavior.
**Dependencies:** product decision on desired behavior.
**Timing:** Future.

### 16. Business Hours conflict banner fix
**Priority:** P3
**Business value:** low-medium — real bug (always shows zero conflicts), but low-risk and well-understood; root cause already confirmed, fix already proposed (`store.bookings` → `store.assembled`).
**Complexity:** small.
**Dependencies:** none.
**Timing:** Future.

### 17. `close_salon_day` time-off backfill gap
**Priority:** P3
**Business value:** low — narrow edge case, more relevant now that Staff's archive/reactivate flow exists.
**Complexity:** small-medium.
**Dependencies:** none.
**Timing:** Future.

### 18. `mark_booking_status` cancellation-notify exception guard
**Priority:** P3
**Business value:** low — edge-case robustness (a notify failure shouldn't be able to block a cancellation).
**Complexity:** small.
**Dependencies:** none.
**Timing:** Future.

### 19. Website inline email/phone validation
**Priority:** P3
**Business value:** low — pure UX polish; server already validates.
**Complexity:** small.
**Dependencies:** none.
**Timing:** Future.

### 20. `booking_services.service_id` backfill
**Priority:** P3
**Business value:** low — would let various archive/reporting checks match by id instead of name, but name-matching works today.
**Complexity:** medium — needs a backfill migration plus a decision on how to handle historical rows with ambiguous name matches.
**Dependencies:** none.
**Timing:** Future.

### 21. Payment line item correction/void UI
**Priority:** P3
**Business value:** low today — schema is ready, but no real correction need has arisen yet.
**Complexity:** medium.
**Dependencies:** none.
**Timing:** Future — do when a real need arises, no rush.

### 22. Demo sandbox data cleanup (Kevin/wrong-salon booking)
**Priority:** P4
**Business value:** negligible — sandbox-only, cosmetic.
**Complexity:** trivial.
**Dependencies:** none.
**Timing:** Future.

---

## Explicitly not on this list

Time-in/flexible scheduling, split/multi-tender payments, deposits, gift cards, packages/memberships — real future work, but product/business decisions to pick up when there's a reason to, not implementation cleanup with a natural place in this priority order.

---

## Completed since the last version of this document

- Dashboard broken-access-control vulnerability found, fixed, deployed, validated end-to-end.
- `aivy-chat` rate limiting + Turnstile — full layered defense (Turnstile invisible-mode + signed trust token + generic three-tier rate limiter: 15 msgs/30min session, 150/hr IP, 1000/day salon). Deployed, browser-validated end-to-end, including the exact 16th-message denial after the session limit was tuned from 30 to 15.
- Website and dashboard deployed via Cloudflare Workers, GitHub auto-deploy on push to `main`.
