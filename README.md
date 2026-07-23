# Velour

An AI-first operating system for independent nail salons. Website, online booking, walk-in kiosk, CRM, dashboard, payroll tracking, and Aivy (AI assistant) — all in one platform, powered by a shared backend.

**First live client:** Red Persimmon Nails & Spa, Manchester, NH.

## What's in this repo

```
dashboard/          Owner/staff dashboard (HTML + JS, served via Cloudflare Workers)
website/            Customer-facing salon website with online booking
kiosk/              Walk-in kiosk for in-salon tablet
edge-functions/     Supabase Edge Functions (the backend API layer)
  aivy-chat.ts        Customer-facing AI chat (Turnstile + rate limiting + trust tokens)
  dashboard-read.ts   Read proxy for dashboard (owner/staff tier, salon-scoped)
  dashboard-write.ts  Write proxy for dashboard (action registry, owner-only gating)
  owner-aivy.ts       Owner-facing AI assistant (per-salon passcode, origin-locked)
docs/               Architecture doc, roadmaps, historical reports
sql/                SQL scripts (historical — migrations applied via Supabase)
```

## Stack

- **Backend:** Supabase (Postgres, Edge Functions, Storage, RLS)
- **Hosting:** Cloudflare Workers (static sites auto-deployed from this repo)
- **AI:** Anthropic API (Claude Haiku) via `aivy-chat` and `owner-aivy` Edge Functions
- **Email:** Make.com webhook for booking confirmations
- **Repo:** This is the source of truth. Edge Functions are deployed to Supabase; HTML/JS is deployed via Cloudflare.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system reference — database schema, Edge Function design, security model, and project roadmap.

## Key design principles

- **Multi-tenant by design:** every query is salon-scoped, never hardcoded to one salon.
- **Server is the final enforcement point:** client-side gating is never sufficient for security.
- **Backend before UI:** every change validated on Demo salon before production.
- **One database table is permanent maintenance:** every new table requires explicit justification.
