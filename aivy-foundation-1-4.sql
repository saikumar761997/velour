-- ============================================================
-- VELOUR — Owner-Aivy Foundations (1 & 4)
-- The single sources of truth for MONEY and TIME. Every Aivy tool,
-- and eventually the dashboard, reads from these — so nothing can drift.
-- Run in Supabase SQL Editor.
-- ============================================================

-- ------------------------------------------------------------
-- FOUNDATION 1 — v_booking_facts  (the money / status truth)
-- Canonical revenue model, defined once:
--   earned   = status 'completed'
--   expected = status in ('confirmed','completed')
--   cancelled / no_show  -> contribute to NEITHER
-- Booking-level money always uses bookings.total_price (one number/booking).
-- security_invoker = true  -> the view respects the caller's RLS, so anon
--   (blocked from bookings) can't read it, while service_role and the
--   SECURITY DEFINER Aivy functions (run as owner) see everything.
-- ------------------------------------------------------------
drop view if exists public.v_booking_facts;
create view public.v_booking_facts
with (security_invoker = true) as
select
  b.id             as booking_id,
  b.salon_id,
  b.customer_id,
  b.technician_id,
  b.booking_date,
  b.start_time,
  b.end_time,
  b.total_duration,
  b.total_price,
  b.status,
  (b.status = 'completed')                         as is_earned,
  (b.status in ('confirmed','completed'))          as is_expected,
  (b.status in ('cancelled','no_show'))            as is_missed,
  case when b.status = 'completed'
       then coalesce(b.total_price, 0) else 0 end  as earned_amount,
  case when b.status in ('confirmed','completed')
       then coalesce(b.total_price, 0) else 0 end  as expected_amount
from bookings b;

revoke all on public.v_booking_facts from anon, public;
grant  select on public.v_booking_facts to service_role, authenticated;


-- ------------------------------------------------------------
-- FOUNDATION 4 — aivy_period_range  (the time truth)
-- Resolves named periods in SALON-LOCAL time (America/New_York) and always
-- returns the current AND previous equal-length window (for "vs last week").
-- Weeks are Monday-start to match the dashboard. Ranges are half-open:
--   include rows where booking_date >= start_date AND booking_date < end_date
-- ------------------------------------------------------------
create or replace function public.aivy_period_range(
  p_period text default 'week',
  p_ref    date default null
)
returns table (start_date date, end_date date, prev_start date, prev_end date, label text)
language plpgsql
stable
as $$
declare
  d   date := coalesce(p_ref, (now() at time zone 'America/New_York')::date);
  dow int;
  s   date;
begin
  if p_period = 'today' then
    return query select d, d + 1, d - 1, d, 'Today'::text;

  elsif p_period = 'month' then
    s := date_trunc('month', d)::date;
    return query
      select s,
             (s + interval '1 month')::date,
             (s - interval '1 month')::date,
             s,
             to_char(s, 'FMMonth YYYY');

  else  -- 'week' (default), Monday start
    dow := extract(isodow from d)::int - 1;   -- Mon=0 .. Sun=6
    s := d - dow;
    return query
      select s,
             s + 7,
             s - 7,
             s,
             ('Week of ' || to_char(s, 'FMMon DD'))::text;
  end if;
end;
$$;

revoke all on function public.aivy_period_range(text, date) from public;
grant execute on function public.aivy_period_range(text, date) to service_role, authenticated;
