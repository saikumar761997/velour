// ============================================================
// Supabase Edge Function: dashboard-write
// Passcode-gated write actions for the staff dashboard, with a second
// independent Payroll-PIN gate on the payroll-numbers actions.
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const LEGACY_DASHBOARD_PASSCODE = Deno.env.get("DASHBOARD_PASSCODE")!;

const ACTIONS: Record<string, string> = {
  mark_status:     "mark_booking_status",
  reschedule:      "reschedule_booking",
  set_timeoff:     "set_technician_time_off",
  clear_timeoff:   "clear_technician_time_off",
  close_salon:     "close_salon_day",
  reopen_salon:    "reopen_salon_day",
  save_notes:      "update_customer_notes",
  reset_tech_link: "reset_tech_token",
  create_booking:  "create_booking",
  checkout:        "checkout_booking",
  set_compensation:      "set_technician_compensation",
  create_payroll_period: "create_payroll_period",
  update_payroll_hours:  "update_payroll_hours",
  preview_payroll:       "calculate_payroll_preview",
  close_payroll_period:  "close_payroll_period",
  change_passcode:       "change_dashboard_passcode",
  set_payroll_pin:       "set_payroll_pin",
  get_settings_status:   "get_settings_status",
  update_business_info:  "update_salon_info",
  update_business_hours: "update_salon_hours",
  upsert_service:        "upsert_service",
  set_service_active:    "set_service_active",
  archive_service:       "archive_service",
  upsert_technician:        "upsert_technician",
  set_technician_active:    "set_technician_active",
  archive_technician:       "archive_technician",
  set_technician_services:  "set_technician_services",
  update_technician_hours:  "update_technician_hours",
};

const PAYROLL_ACTIONS = new Set([
  "set_compensation",
  "create_payroll_period",
  "update_payroll_hours",
  "preview_payroll",
  "close_payroll_period",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

async function verifyPasscode(salonId: string | undefined, passcode: string): Promise<boolean> {
  if (!salonId) {
    return passcode === LEGACY_DASHBOARD_PASSCODE;
  }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_dashboard_passcode`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_salon_id: salonId, p_passcode: passcode }),
  });
  if (!r.ok) return false;
  const ok = await r.json().catch(() => false);
  return ok === true;
}

async function verifyPayrollPin(salonId: string | undefined, pin: string | undefined): Promise<boolean> {
  if (!salonId) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_payroll_pin`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_salon_id: salonId, p_pin: pin || "" }),
  });
  if (!r.ok) return false;
  const ok = await r.json().catch(() => false);
  return ok === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { action, args, passcode, salon_id, payroll_pin } = await req.json();
    if (!(await verifyPasscode(salon_id, passcode))) return json({ error: "unauthorized" }, 401);

    const fn = ACTIONS[action];
    if (!fn) return json({ error: "unknown_action" }, 403);

    if (PAYROLL_ACTIONS.has(action)) {
      if (!(await verifyPayrollPin(salon_id, payroll_pin))) {
        return json({ error: "payroll_pin_required" }, 401);
      }
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args || {}),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return json({ ok: false, error: (data && (data.message || data.error)) || `HTTP ${r.status}` }, r.status);
    }
    return json({ ok: true, result: data });
  } catch (e) {
    console.error("dashboard_write_error", String(e));
    return json({ error: "server_error" }, 500);
  }
});
