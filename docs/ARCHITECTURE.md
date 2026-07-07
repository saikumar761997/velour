# Velour — Salon Management Platform

Velour is a salon management SaaS. First client: **Red Persimmon Nails & Spa** (Manchester, NH; owner Kristy).

This document is the single source of truth for how the system is built and where things live. It doubles as a handoff summary for continuing work in a fresh session.

---

## Stack

- **Public website** — static `index.html`, hosted on **Cloudflare Workers** (`red-persimmon.redpersimmon.workers.dev`).
- **Owner dashboard** — static `velour-dashboard.html`, opened directly (passcode-gated).
- **Backend** — **Supabase** (Postgres + RLS + Edge Functions). Project ref: `hydhezpeuhqhcugnpupu`.
- **Email automation** — **Make.com** (confirmation / reminder / cancel / reschedule).

## Key identifiers

- Salon ID: `a0000000-0000-0000-0000-000000000001`
- Technician IDs: `b0000000-0000-0000-0001-000000000001` … `-000000000010`
- Anon key: public, embedded in the site (safe by design).
- Secrets (Supabase only, never in repo): `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_PASSCODE`.

---

## Repository layout

```
velour-platform/
├── website/
│   └── index.html                 Public booking site (+ Manage & tech-schedule overlays)
├── dashboard/
│   └── velour-dashboard.html      Owner dashboard (Today/Week/Insights/Customers/Technicians/Aivy)
├── edge-functions/
│   ├── aivy-chat.ts               Customer chatbot proxy (Anthropic)
│   ├── owner-aivy.ts              Owner assistant (passcode-gated, data snapshot → Anthropic)
│   ├── dashboard-read.ts          Whitelisted table reads for the dashboard
│   └── dashboard-write.ts         Whitelisted actions (status/reschedule/timeoff/closures/notes/tech-link)
├── sql/
│   ├── aivy-foundation-1-4.sql    Owner-Aivy Foundations: v_booking_facts view + aivy_period_range()
│   ├── noprefs-fix.sql            create_booking: assign least-busy QUALIFIED free tech on "no preference"
│   └── (other velour-*.sql migrations, in run order)
└── docs/
    └── ARCHITECTURE.md            This file
```

> **Note:** Edge Functions and SQL functions run live in Supabase. The files here are the source-of-truth copies. When editing, change the file here **and** deploy/run in Supabase.

---

## Database (key tables)

- `salons`, `salon_hours` (`day_of_week`, `open_time`, `close_time`, `is_open`)
- `technicians` (`available_days[]`, `active`), `technician_services` (287 mappings), `technician_links` (read-only schedule tokens — locked)
- `services` (`duration_minutes`, `price`, `price_from`, `category`, `active`)
- `customers`, `bookings` (`booking_date` + `start_time`/`end_time`, `status`, `total_price`, `total_duration`, `manage_token`), `booking_services`
- `technician_time_off` (partial/all-day + salon closures), `email_logs`

**UUID note:** all id/token defaults use `gen_random_uuid()` (the `uuid-ossp` extension proved unreliable in this project).

---

## Canonical models (single source of truth — do not diverge)

- **Revenue:** `earned` = status `completed`; `expected` = status `confirmed`+`completed`; `cancelled`/`no_show` = neither. Booking-level money = `bookings.total_price`; service-level = `booking_services.price`. `avg_ticket` = earned ÷ completed count.
  - Dashboard Insights shows **earned**; Today/Week labeled **expected**.
  - Enforced in SQL by the `v_booking_facts` view.
- **Dates:** `aivy_period_range()` resolves today/week/month in salon-local time (America/New_York), Monday-start weeks, and returns the previous equal-length window for comparisons.
- **Customer tags:** VIP = spend ≥ $300 OR visits ≥ 6; Lapsed = ≥1 visit and >8 weeks since last; Regular = ≥2 active; New = 0–1. Same thresholds used by dashboard and (planned) Aivy customer-stats.

---

## What's live and working

- Public booking (service → technician → slot), availability + double-booking checks, 2-hour lead time.
- **"No preference"** assigns the least-busy technician who works that day, is not off, has no clash, **and is qualified for every booked service**; refuses if none (`NO_TECH_AVAILABLE`).
- Customer emails via Make; token Manage page (`?manage=`); per-technician read-only schedule links (`?tech=`).
- Dashboard: Today, Week (with open-slot gaps), Insights, Customers (segments + tags + sort), Technicians (time off, closures, copy/reset schedule links), **Aivy** (auto-briefing + chat via `owner-aivy`).
- Security: RLS locked; passcode/token gating; no secrets in the site.
- Website polish: booking-flow states (loading/empty/error/success, availability-error fixed), Aivy hero rebalanced, accordion animations, consistent "Book Appointment" wording.

---

## In progress / next

- **Website Phase 1 — DB-driven catalog.** Replace hardcoded `TECH_DB` / `SVC_DUR` / `SALON_HRS` / `TECH_SERVICES` in `index.html` with a `loadCatalog()` that fetches these tables on load and fills the **same** JS objects (adapter pattern, booking logic unchanged), keeping the hardcoded values as a **fallback** if the fetch fails. Data-readiness audit is **done** — DB matches hardcoded values exactly; no seeding needed. Build order: shadow-load + verify → swap `SVC_DUR`+`SALON_HRS` → swap `TECH_DB` → swap `TECH_SERVICES` → offline/kill-switch test. Config (`BUFFER=10`, `MIN_HRS=2`, `MAX_DAYS=28`) stays JS constants for now.
- **Owner-Aivy tools** (on the foundations): `aivy_revenue_summary`, `aivy_day_schedule`, `aivy_top_services` → then Foundation 2 (customer-stats) + customer tools → then Foundation 3 (availability) + open-slots/utilization → then reports.
- **Security before public launch:** rate-limit `aivy-chat` (cost), Turnstile on booking (spam).
- **Before Kristy goes live:** test-data cleanup (delete all test bookings/customers/closures; keep catalog + technician_links).

---

## Website Phase 2 (later, low risk)

Promo banner, service-card display (names/prices/descriptions), team bios/photos, FAQ, hero copy, contact info, gallery → DB-driven via a dashboard "Website content" editor. Add a `settings` table then (also a home for booking config). Optional: custom domain (fixes email spam), multi-tenant.
