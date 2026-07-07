-- ============================================================
-- VELOUR — Fix: "no preference" now assigns a real available technician
-- Run in Supabase SQL Editor. Replaces create_booking so that when
-- p_tech is null, it picks the least-busy technician who (a) works that
-- weekday, (b) isn't on time off / closure, (c) has no conflicting booking.
-- If none is free, the booking is refused (NO_TECH_AVAILABLE).
-- ============================================================

create or replace function public.create_booking(
  p_salon    uuid,
  p_name     text,
  p_email    text,
  p_phone    text,
  p_tech     uuid,
  p_date     date,
  p_start    time,
  p_end      time,
  p_duration int,
  p_price    numeric,
  p_notes    text,
  p_services jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer      uuid;
  v_booking       uuid;
  v_conflict      int;
  v_tech_name     text;
  v_token         uuid;
  v_services_text text;
  v_manage_url    text;
  v_assigned      uuid;
  v_dow           text := trim(to_char(p_date, 'dy'));   -- 'mon','tue',...
  v_base          text := 'https://red-persimmon.redpersimmon.workers.dev';
  svc             jsonb;
begin
  if p_salon is null or p_date is null or p_start is null or p_end is null then
    raise exception 'MISSING_FIELDS';
  end if;
  if p_end <= p_start then
    raise exception 'INVALID_TIME_RANGE';
  end if;

  -- ---- No preference: assign the least-busy AVAILABLE + QUALIFIED technician ----
  if p_tech is null then
    select t.id
      into v_assigned
    from technicians t
    where t.salon_id = p_salon
      and coalesce(t.active, true) = true
      and ( t.available_days is null
            or array_length(t.available_days, 1) is null
            or v_dow = any(t.available_days) )
      -- qualified for EVERY service in the booking
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
      and not exists (                                  -- no clashing booking
        select 1 from bookings b
        where b.salon_id = p_salon and b.technician_id = t.id
          and b.booking_date = p_date and b.status <> 'cancelled'
          and b.start_time < p_end and b.end_time > p_start )
      and not exists (                                  -- not on time off / closure
        select 1 from technician_time_off o
        where o.salon_id = p_salon and o.technician_id = t.id and o.off_date = p_date
          and ( o.all_day = true
                or (coalesce(o.start_time, time '00:00') < p_end
                    and coalesce(o.end_time, time '23:59:59') > p_start) ) )
    order by
      (select count(*) from bookings b2
       where b2.salon_id = p_salon and b2.technician_id = t.id
         and b2.booking_date = p_date and b2.status <> 'cancelled') asc,
      random()
    limit 1;

    if v_assigned is null then
      raise exception 'NO_TECH_AVAILABLE';
    end if;
    p_tech := v_assigned;
  end if;

  -- ---- Double-booking guard (now always has a real technician) ----
  select count(*) into v_conflict
  from bookings b
  where b.salon_id = p_salon and b.technician_id = p_tech
    and b.booking_date = p_date and b.status <> 'cancelled'
    and b.start_time < p_end and b.end_time > p_start;
  if v_conflict > 0 then raise exception 'SLOT_TAKEN'; end if;

  -- ---- Customer: find by salon+email, else create ----
  if p_email is not null and length(trim(p_email)) > 0 then
    select id into v_customer
    from customers
    where salon_id = p_salon and lower(email) = lower(trim(p_email))
    limit 1;
  end if;

  if v_customer is null then
    insert into customers (salon_id, name, email, phone, source, first_visit, last_visit, total_visits, total_spent)
    values (p_salon, p_name, p_email, p_phone, 'website', null, null, 0, 0)
    returning id into v_customer;
  else
    update customers set
      name  = coalesce(nullif(trim(p_name),  ''), name),
      phone = coalesce(nullif(trim(p_phone), ''), phone)
    where id = v_customer;
  end if;

  -- ---- Booking ----
  insert into bookings (salon_id, customer_id, technician_id, source, status,
                        booking_date, start_time, end_time, total_duration, total_price, notes)
  values (p_salon, v_customer, p_tech, 'website', 'confirmed',
          p_date, p_start, p_end, p_duration, p_price, p_notes)
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
        'customer_email', p_email,
        'customer_phone', p_phone,
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

  return v_booking;
end;
$$;
