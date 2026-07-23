# Velour — SQL Database Objects

Production database snapshot synced from Supabase on July 23, 2026.
These files represent the current state of all custom database objects
in the `public` schema. They are reference copies — the live database
is the actual source of truth, and these files are synced periodically
to keep the repository accurate.

## Folder Structure

```
sql/
  functions/        37 PostgreSQL functions (RPCs)
  policies/         RLS policies and table security configuration
  README.md         This file
```

## functions/

One file per function, named to match the function name. Each file
contains the exact `CREATE OR REPLACE FUNCTION` statement as it
exists in production. All functions are `SECURITY DEFINER` with
`search_path = public` (except `_ws_merge_text` which is a pure
helper marked `IMMUTABLE`).

Functions are grouped by purpose:

**Booking flow:**
`create_booking`, `get_availability`, `get_booking_by_token`,
`cancel_booking_by_token`, `reschedule_booking`, `mark_booking_status`

**Checkout & payments:**
`checkout_booking`

**Walk-in kiosk:**
`join_walkin_queue`, `set_queue_status`

**Dashboard — salon management:**
`update_salon_info`, `update_salon_hours`, `close_salon_day`,
`reopen_salon_day`

**Dashboard — service management:**
`upsert_service`, `set_service_active`, `archive_service`,
`set_service_category_image`

**Dashboard — technician management:**
`upsert_technician`, `set_technician_active`, `archive_technician`,
`set_technician_services`, `set_technician_time_off`,
`clear_technician_time_off`, `update_technician_hours`,
`reset_tech_token`, `get_tech_schedule`

**Payroll:**
`set_technician_compensation`, `create_payroll_period`,
`calculate_payroll_preview`, `update_payroll_hours`,
`close_payroll_period`, `reopen_payroll_period`

**Website CMS:**
`update_website_settings`, `add_website_gallery_image`,
`update_website_gallery_image`, `archive_website_gallery_image`

**Authentication & security:**
`verify_dashboard_passcode`, `set_staff_passcode`,
`change_dashboard_passcode`, `verify_payroll_pin`, `set_payroll_pin`,
`get_settings_status`, `check_and_increment_rate_limit`

**Notifications:**
`velour_notify`, `send_reminders`

**Utilities:**
`_ws_merge_text`, `update_customer_notes`

## policies/

`rls_policies.sql` contains all Row Level Security configuration:
RLS is enabled on all 25 tables, with 10 public SELECT policies
allowing the website to read salon data via the Supabase anon key.
All write operations bypass RLS via security-definer Edge Functions
using the service role key.

## Known Production Inconsistencies

The following functions still reference the old domain
`red-persimmon.redpersimmon.workers.dev` instead of the current
`velour-website.redpersimmon.workers.dev`. These are captured as-is
(matching production) and flagged for a future fix:

- `cancel_booking_by_token`
- `mark_booking_status`
- `reschedule_booking`

## How to Use

These files are **not** meant to be run as migrations. They are
reference snapshots. To deploy changes:

1. Edit the function in a development session
2. Test against the Demo salon
3. Deploy via `apply_migration` in Supabase
4. Sync the updated definition back to this repository

Never run these files directly against production without comparing
them to what's currently deployed — the live database may have been
updated since the last sync.
