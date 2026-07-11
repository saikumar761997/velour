Velour — Production Readiness Report

Dashboard Authorization Redesign & Rollout

Date of this report: July 11, 2026
Scope: dashboard-read and dashboard-write Edge Functions, plus regression validation of the salon dashboard and public website against the live Supabase project (hydhezpeuhqhcugnpupu).


1. Executive Summary

A critical broken-access-control vulnerability was discovered in the two Edge Functions backing the Velour dashboard: dashboard-read and dashboard-write verified a caller's passcode against a claimed salon_id, but never bound that verified identity to the data actually read or written afterward. A session authenticated as one salon could read or write another salon's data — confirmed live, not theoretically, using a real cross-salon proof-of-concept against production data (Demo credentials successfully read Red Persimmon's real bookings, customers, and payments).

This was redesigned from the ground up as a single, centralized authorization layer (_shared/authz.ts) shared by both Edge Functions, built around a registry-driven, default-deny model rather than per-RPC patches. The redesign was deliberately paced through architecture review, adversarial self-review, live proof-of-concept validation, implementation, a full code review that caught and fixed two additional real bugs before deployment, and — after two deployment mistakes were caught and corrected — a complete functional regression matrix executed against the live, deployed system with a real browser, not simulated.

The vulnerability is closed, verified live, and the fix has been validated end-to-end against real production infrastructure. No known open security issue remains in the dashboard authorization boundary.


2. Scope Completed


Full architectural redesign of dashboard authorization: ENTITY_REGISTRY, ACTION_REGISTRY, AUTH_SCOPE, two-step ID resolution, default-deny, structured reason-code logging.
Complete rewrite of dashboard-read and dashboard-write Edge Functions on top of the shared authorization layer.
Legacy global-passcode fallback fully removed (confirmed no other caller depended on it).
Self-review that caught and fixed, before deployment: a query-building bug that would have broken payroll-history and booking-services chunked reads; a recursion depth guard; a JS prototype-chain lookup bypass (__proto__/constructor keys defeating registry checks); an unbounded read-scoping query later replaced with a bounded, DB-side ownership check.
Live proof-of-concept validation of both the original vulnerability and the fix, directly against Supabase.
Frontend deployment to Cloudflare (Workers, static assets, GitHub-integrated auto-deploy) — dashboard.html and website.html required zero code changes to work with the new backend, confirmed by design and by live testing.
A full functional regression matrix executed against the live deployed system using a real, connected browser: dashboard data integrity, Services/Technicians CRUD, full booking lifecycle, Settings (Business Info, Business Hours, Dashboard Passcode, Payroll PIN), and the public website's booking + Manage Appointment flow.


3. Explicitly Out of Scope (by deliberate decision, not oversight)


Owner-Aivy (owner-aivy Edge Function) — uses a separate, still-legacy, single-tenant authentication mechanism (global DASHBOARD_PASSCODE env var, no salon_id parameter, hardcoded Red Persimmon content). Discovered during this project, explicitly scoped out of this deployment, tracked as a separate future project.
Double-unlock() UI robustness issue — re-triggering the dashboard's unlock flow without a page reload can freeze the browser tab. Cosmetic/robustness, not security, not a normal user path. Tracked as technical debt.
Any RPC business-logic changes — none were made. Every RPC signature, validation rule, and behavior is exactly as it was before this project.
Database schema — no migrations were required or applied as part of this work.


4. Final PASS / FAIL / BLOCKED Table

AreaResultCross-salon read exploit (original vulnerability)FIXED — verified liveCross-salon write — Category A (salon-argument RPCs)FIXED — verified liveCross-salon write — Category B (record-bound RPCs)FIXED — verified liveLegacy passcode fallback removalPASS — confirmed no dependentsFrontend compatibility (zero client changes)PASS — confirmed via source audit and live testingDashboard data integrity (6 entity types)PASSServices & Technicians CRUDPASSBooking lifecycle (create/reschedule/checkout/cancel/no-show)PASSSettings (Business Info, Hours, Passcode, Payroll PIN)PASSOwner-AivyBLOCKED / OUT OF SCOPE (pre-existing architecture, tracked separately)Website booking flow (create, confirm, manage, cancel)PASSEdge Function runtime health (post-deploy logs)PASS — zero errors observed

5. Remaining Technical Debt


Owner-Aivy authentication/multi-tenancy — global passcode, no salon scoping, hardcoded content. Needs its own project.
Double-unlock() tab freeze — no in-flight guard on boot()/loadAll(). Low priority, no known real-world trigger.
Website "Reschedule" is cancel-then-rebook, not atomic — intentional by original design, but means a customer can lose their slot mid-flow with no rollback. Worth a product decision, not a bug.
_shared/authz.ts is duplicated, not truly shared — both Edge Functions carry an identical inline copy rather than importing one module, because the deploy tool's cross-function relative-import resolution was unverified and a first deploy attempt with a placeholder file exposed the risk of guessing. Functionally correct and fully verified, but any future change to the authorization logic must be applied to both files identically until this is revisited.
Pre-existing debt, unaffected by this project, still open: payments/payment_line_items RLS disabled; mark_booking_status's cancellation-notify call not exception-guarded; Business Hours conflict banner reads from the wrong store; one Demo sandbox booking with a cross-salon technician mismatch; close_salon_day doesn't backfill time-off for technicians added after a closure; booking_services.service_id not populated (name-matching used instead); aivy-chat rate limiting/Turnstile not implemented; Checkout and Payroll flows not yet browser-validated for Red Persimmon specifically (Demo is now validated).


6. Overall Production Readiness Assessment

The dashboard authorization layer is production-ready. The specific vulnerability that motivated this entire project is closed, verified through live exploitation-style testing both before and after the fix, and the fix has been validated against real production infrastructure with a real browser — not just code review or SQL simulation.

Recommended before Red Persimmon relies on this in its normal daily operation: a quick confirmation that Red Persimmon's own passcode still authenticates correctly post-deploy (not yet directly tested — all live browser testing this session used Demo, per your own stated preference for Demo-first validation). This is a five-minute check, not a blocker to calling this phase complete.

Not production-ready, and correctly excluded from this deployment's scope: Owner-Aivy's authentication model. It was already this way before this project began, is not made worse by this project, and should not be conflated with the authorization work that has now been completed and validated.
