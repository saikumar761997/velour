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
- Secrets in Supabase only (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_PASSCODE`). Anon key in site is public/safe.

---

## 3. Repo layout (`velour-platform`)

```
website/index.html
dashboard/velour-dashboard.html
edge-functions/  aivy-chat.ts  owner-aivy.ts  dashboard-read.ts  dashboard-write.ts
sql/  aivy-foundation-1-4.sql  noprefs-fix.sql  (+ older velour-*.sql migrations)
docs/ARCHITECTURE.md
```
Edge Functions & SQL run live in Supabase; repo files are the source-of-truth copies. Edit here **and** deploy/run in Supabase.

---

## 4. Canonical models (never diverge)

- **Revenue:** earned = `completed`; expected = `confirmed`+`completed`; cancelled/no_show = neither. Booking money = `bookings.total_price`; service money = `booking_services.price`; avg_ticket = earned ÷ completed. Insights = earned; Today/Week = expected. Enforced by `v_booking_facts`.
- **Dates:** `aivy_period_range()` — today/week/month in salon-local (America/New_York), Monday-start, returns previous window too.
- **Customer tags:** VIP = spend ≥ $300 OR ≥6 visits; Lapsed = ≥1 visit & >8 weeks; Regular = ≥2 active; New = 0–1.
- **UUIDs:** all id/token defaults use `gen_random_uuid()`.
- **Multi-tenant discipline:** salon-scoped everywhere; never hardcode one salon's values in new work.

---

## 5. Database (key tables)

`salons`, `salon_hours` (day_of_week/open_time/close_time/is_open) · `technicians` (available_days[], active), `technician_services` (287), `technician_links` (locked read-only tokens) · `services` (duration_minutes, price, price_from, category, active) · `customers`, `bookings` (booking_date + start/end_time, status, total_price, total_duration, manage_token), `booking_services` · `technician_time_off` (partial/all-day + salon closures) · `email_logs`.

---

## 6. What's live & working

- Public booking (service→tech→slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns least-busy tech who works that day, isn't off, has no clash, and is **qualified for every booked service**; refuses if none.
- Customer emails via Make; token Manage page (`?manage=`); per-tech read-only schedule links (`?tech=`).
- Dashboard: Today, Week (open-slot gaps), Insights, Customers (segments+tags+sort), Technicians (time off, closures, copy/reset schedule links), **Aivy** (auto-briefing + chat; `owner-aivy` function deployed, still shallow — see backlog).
- Security: RLS locked; passcode/token gating; no secrets in site.
- Website polish: booking-flow states (loading/empty/error/success + availability-error fix), Aivy hero rebalanced, accordion animations, consistent "Book Appointment" wording.
- Owner-Aivy Foundations **1 & 4** built (`v_booking_facts`, `aivy_period_range`).
- Data-readiness audit **done**: DB services/durations/prices, technician days/ids, salon_hours, technician_services all **match** hardcoded site values. No seeding needed.

---

## 7. PRIORITIES (current)

**Launch blockers → then Kristy goes live:**
1. Diagnose & fix **duplicate bookings** (correctness — bug vs test-data unknown; check data first).
2. **Walk-in entry** in dashboard (daily-use blocker).
3. **Security:** rate-limit `aivy-chat`; booking spam protection (Turnstile).
4. **Test-data cleanup** (wipe fake bookings/customers/closures; keep catalog + technician_links).
5. **GO LIVE** — real-world test with Kristy.

**Fast follows (after live, guided by real usage):**
6. Finish **Owner-Aivy** (tool-calling on foundations: revenue_summary/day_schedule/rebooking → customer tools → reports/documents).
7. **Time-in / flexible scheduling** (shift-swaps, covering) — folds into Owner-Aivy **Foundation 3** (shared availability). Decision: covered shifts should be **bookable online** (one availability truth), not manual-only. Model = weekly default (available_days) + exceptions both directions (time-off you have; add time-in).
8. **Website Phase 1** — DB-driven catalog (`loadCatalog()` fills existing JS objects from DB, hardcoded fallback; audit done). Unlocks live-editable schedules/hours.
9. **Change-password** setting in dashboard (small).

**Parked (post-first-results / need Kristy content / multi-salon):**
10. De-static website (gallery, reviews, editable content = Website Phase 2); **Reputation Engine** (review requests first, scoped); multi-tenant hardening; custom domain (fixes email spam); optional re-engagement email, full tech logins.

---

## 8. Ideas backlog (capture, don't lose)

- **Reputation Engine** (Google reviews): start with automated review *request* tied to email flow; later analytics, AI response drafts, feedback insights, reputation dashboard, before/after gallery, growth metrics. Validate demand in owner interviews first. Seductive over-build — keep scoped.
- **Owner interviews:** talk to 15–20 independent nail salon owners before big new builds — validate what they'll pay for.
- **Repeatable onboarding:** templatize services/tech/hours/branding/deploy so salon #2 takes a day, not weeks (can be a manual checklist first).
- **Pricing:** validate a real SaaS price; charge Red Persimmon or a friendly salon (money = only unfaked signal).
- **Usage instrumentation:** once live, track booking completion, Aivy questions, tab usage, no-show rate — let behavior guide the roadmap.
- **Non-hardcoded schedule:** move fully to weekly-default + exceptions so scheduling is data-driven (multi-tenant friendly; next salon = config).
- **Lean one-page Blueprint** now; full founder Blueprint only after 3–5 paying salons.

---

## 9. Working style / how to operate

Non-technical, step-by-step, one thing at a time; backend before UI; test in pieces; fallback for anything touching live booking; validate JS/SQL before presenting; confirm before destructive actions. When founder is stressed, give the single next step, not the whole list. Co-founder stance: challenge weak ideas, protect against feature bloat and building-instead-of-selling. One chat = one task (saves usage, sharpens output); update this doc after milestones.
