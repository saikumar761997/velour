// ============================================================
// Supabase Edge Function: dashboard-write
// Passcode-gated write actions for the staff dashboard.
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const DASHBOARD_PASSCODE = Deno.env.get("DASHBOARD_PASSCODE")!;

const ACTIONS: Record<string, string> = {
  mark_status:     "mark_booking_status",
  reschedule:      "reschedule_booking",
  set_timeoff:     "set_technician_time_off",
  clear_timeoff:   "clear_technician_time_off",
  close_salon:     "close_salon_day",
  reopen_salon:    "reopen_salon_day",
  save_notes:      "update_customer_notes",
  reset_tech_link: "reset_tech_token",
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { action, args, passcode } = await req.json();
    if (passcode !== DASHBOARD_PASSCODE) return json({ error: "unauthorized" }, 401);

    const fn = ACTIONS[action];
    if (!fn) return json({ error: "unknown_action" }, 403);

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
