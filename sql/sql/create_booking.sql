-- ============================================================
-- VELOUR — create_booking (current production version)
--
-- Synced from live Supabase database: July 23, 2026
-- This is the single source of truth for the booking function.
--
-- Core booking function called by website, dashboard, and kiosk.
-- Handles: input validation, business hours enforcement, technician
-- hours enforcement, email/phone validation, service catalog
-- validation, "no preference" capacity check, double-booking guard,
-- customer upsert, booking + booking_services insert, and Make.com
-- email notification (skipped for walk-ins).
--
-- 15 parameters (last 3 have defaults for backward compatibility):
--   p_salon, p_name, p_email, p_phone, p_tech, p_date, p_start,
--   p_end, p_duration, p_price, p_notes, p_services,
--   p_source (default 'website'), p_customer_id (default null),
--   p_created_by (default null)
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_booking(
  p_salon uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_tech uuid,
  p_date date,
  p_start time without time zone,
  p_end time without time zone,
  p_duration integer,
  p_price numeric,
  p_notes text,
  p_services jsonb,
  p_source text DEFAULT 'website'::text,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_created_by text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_customer      uuid;
  v_booking       uuid;
  v_conflict      int;
  v_tech_name     text;
  v_token         uuid;
  v_services_text text;
  v_manage_url    text;
  v_capacity      int;
  v_unassigned    int;
  v_dow           text := trim(to_char(p_date, 'dy'));
  v_base          text := 'https://velour-website.redpersimmon.workers.dev';
  v_source        text := lower(trim(coalesce(nullif(p_source, ''), 'website')));
  v_email         text;
  v_phone         text;
  v_enforce_hours boolean;
  v_hours_is_open boolean;
  v_hours_open    time;
  v_hours_close   time;
  v_enforce_tech_hours boolean;
  svc             jsonb;
begin
  if p_salon is null or p_date is null or p_start is null or p_end is null then
    raise exception 'MISSING_FIELDS';
  end if;
  if p_end <= p_start then
    raise exception 'INVALID_TIME_RANGE';
  end if;

  if v_source = 'website' then
    select coalesce(enforce_business_hours, false) into v_enforce_hours
    from salon_settings where salon_id = p_salon;

    if coalesce(v_enforce_hours, false) then
      select is_open, open_time, close_time
        into v_hours_is_open, v_hours_open, v_hours_close
      from salon_hours
      where salon_id = p_salon and day_of_week = lower(v_dow);

      if not found or coalesce(v_hours_is_open, false) = false then
        raise exception 'SALON_CLOSED';
      end if;

      if p_start < v_hours_open or p_end > v_hours_close then
        raise exception 'OUTSIDE_BUSINESS_HOURS';
      end if;

      if exists (
        select 1 from technician_time_off o
        where o.salon_id = p_salon and o.off_date = p_date and o.salon_closure = true
          and ( o.all_day = true
                or (coalesce(o.start_time, time '00:00') < p_end
                    and coalesce(o.end_time, time '23:59:59') > p_start) )
      ) then
        raise exception 'SALON_CLOSED';
      end if;
    end if;
  end if;

  if p_email is not null and length(trim(p_email)) > 0 then
    v_email := lower(trim(p_email));
    if v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
      raise exception 'INVALID_EMAIL';
    end if;
  else
    v_email := null;
  end if;

  if p_phone is not null and length(trim(p_phone)) > 0 then
    v_phone := regexp_replace(p_phone, '\D', '', 'g');
    if length(v_phone) = 11 and left(v_phone,1) = '1' then
      v_phone := substring(v_phone from 2);
    end if;
    if length(v_phone) <> 10 then
      raise exception 'INVALID_PHONE';
    end if;
  else
    v_phone := null;
  end if;

  if p_services is not null then
    for svc in select * from jsonb_array_elements(p_services)
    loop
      if not exists (
        select 1 from services s
        where s.salon_id = p_salon
          and lower(trim(s.name)) = lower(trim(coalesce(svc->>'name', '')))
          and s.active = true
          and s.archived_at is null
      ) then
        raise exception 'SERVICE_NOT_AVAILABLE: %', svc->>'name';
      end if;
    end loop;
  end if;

  select coalesce(enforce_technician_hours, false) into v_enforce_tech_hours
  from salon_settings where salon_id = p_salon;
  v_enforce_tech_hours := coalesce(v_enforce_tech_hours, false);

  -- "No preference" now genuinely means no preference.
  -- Previously a technician was auto-assigned the instant a website
  -- booking came in, which put a specific name on the calendar that
  -- nobody had actually decided -- and that name was frequently wrong,
  -- since the salon reassigns on the day based on who is actually free.
  -- Walk-ins already worked this way; website bookings now match.
  --
  -- The auto-assign was, however, also what prevented overbooking (it
  -- checked one named technician's calendar). With no technician to
  -- check, that guard is replaced by a CAPACITY check: count technicians
  -- who could actually perform these services at this time and are not
  -- already taken, then subtract bookings already holding a slot without
  -- an assigned technician. If nothing is left, the slot is genuinely
  -- full and the booking is refused.
  if p_tech is null and v_source <> 'walk_in' then
    select count(*)
      into v_capacity
    from technicians t
    where t.salon_id = p_salon
      and coalesce(t.active, true) = true
      and ( t.available_days is null
            or array_length(t.available_days, 1) is null
            or v_dow = any(t.available_days) )
      and ( v_source <> 'website' or not v_enforce_tech_hours
            or exists (
              select 1 from technician_hours th
              where th.technician_id = t.id
                and th.day_of_week = lower(v_dow)
                and th.is_available = true
                and th.start_time <= p_start
                and th.end_time >= p_end
            ) )
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(p_services, '[]'::jsonb)) reqs
        where not exists (
          select 1 from technician_services ts
          join services s on s.id = ts.service_id
          where ts.technician_id = t.id
            and lower(trim(s.name)) = lower(trim(reqs->>'name'))
        )
      )
      and not exists (
        select 1
        from bookings b
        where b.salon_id = p_salon and b.technician_id = t.id
          and b.booking_date = p_date and b.status <> 'cancelled'
          and b.start_time < p_end and b.end_time > p_start )
      and not exists (
        select 1 from technician_time_off o
        where o.salon_id = p_salon and o.technician_id = t.id and o.off_date = p_date
          and ( o.all_day = true
                or (coalesce(o.start_time, time '00:00') < p_end
                    and coalesce(o.end_time, time '23:59:59') > p_start) ) );

    select count(*)
      into v_unassigned
    from bookings b
    where b.salon_id = p_salon
      and b.technician_id is null
      and b.booking_date = p_date
      and b.status <> 'cancelled'
      and b.start_time < p_end and b.end_time > p_start;

    if coalesce(v_capacity, 0) - coalesce(v_unassigned, 0) <= 0 then
      raise exception 'NO_TECH_AVAILABLE';
    end if;
    -- p_tech deliberately left NULL: the salon decides on the day, and
    -- checkout records who actually performed the service.
  end if;

  if v_source = 'website' and v_enforce_tech_hours and p_tech is not null then
    if not exists (
      select 1 from technician_hours th
      where th.technician_id = p_tech
        and th.day_of_week = lower(v_dow)
        and th.is_available = true
        and th.start_time <= p_start
        and th.end_time >= p_end
    ) then
      raise exception 'TECHNICIAN_OUTSIDE_HOURS';
    end if;
  end if;

  if p_tech is not null then
    select count(*) into v_conflict
    from bookings b
    where b.salon_id = p_salon and b.technician_id = p_tech
      and b.booking_date = p_date and b.status <> 'cancelled'
      and b.start_time < p_end and b.end_time > p_start;
    if v_conflict > 0 then raise exception 'SLOT_TAKEN'; end if;
  end if;

  if p_customer_id is not null then
    v_customer := p_customer_id;
    update customers set
      name  = coalesce(nullif(trim(p_name),  ''), name),
      phone = coalesce(v_phone, phone),
      email = coalesce(v_email, email)
    where id = v_customer;
  else
    if v_email is not null then
      select id into v_customer
      from customers
      where salon_id = p_salon and lower(email) = v_email
      limit 1;
    end if;

    if v_customer is null then
      insert into customers (salon_id, name, email, phone, source, first_visit, last_visit, total_visits, total_spent)
      values (p_salon, p_name, v_email, v_phone, v_source, null, null, 0, 0)
      returning id into v_customer;
    else
      update customers set
        name  = coalesce(nullif(trim(p_name),  ''), name),
        phone = coalesce(v_phone, phone)
      where id = v_customer;
    end if;
  end if;

  insert into bookings (salon_id, customer_id, technician_id, source, status,
                        booking_date, start_time, end_time, total_duration, total_price, notes,
                        created_by, customer_name)
  values (p_salon, v_customer, p_tech, v_source, 'confirmed',
          p_date, p_start, p_end, p_duration, p_price, p_notes,
          nullif(trim(p_created_by), ''), nullif(trim(p_name), ''))
  returning id, manage_token into v_booking, v_token;

  if p_services is not null then
    for svc in select * from jsonb_array_elements(p_services)
    loop
      insert into booking_services (booking_id, service_name, price, duration_minutes)
      values (v_booking,
              coalesce(svc->>'name', 'Service'),
              coalesce((svc->>'price')::numeric, 0),
              coalesce((svc->>'duration_minutes')::int, 30));
    end loop;
  end if;

  if v_source <> 'walk_in' then
    select coalesce(string_agg(x->>'name', ', '), '')
      into v_services_text
    from jsonb_array_elements(coalesce(p_services, '[]'::jsonb)) x;

    v_manage_url := v_base || '/?manage=' || v_token::text;
    select name into v_tech_name from technicians where id = p_tech;

    begin
      perform net.http_post(
        url := 'https://hook.us2.make.com/efp1nqeghxkdpc7utxog7a54ingvry9e',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object(
          'booking_id',     v_booking,
          'customer_name',  p_name,
          'customer_email', v_email,
          'customer_phone', v_phone,
          'technician',     coalesce(v_tech_name, 'Any available'),
          'date',           to_char(p_date, 'FMDay, FMMonth DD, YYYY'),
          'start_time',     to_char(p_start, 'HH12:MI AM'),
          'services',       p_services,
          'services_text',  v_services_text,
          'total_price',    p_price,
          'duration_min',   p_duration,
          'notes',          p_notes,
          'manage_token',   v_token,
          'manage_url',     v_manage_url
        )
      );
    exception when others then null;
    end;
  end if;

  return v_booking;
end;
$function$;
