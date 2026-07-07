// ============================================================
// Supabase Edge Function: dashboard-read
// Read-only proxy for the staff dashboard. Passcode-gated.
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const DASHBOARD_PASSCODE = Deno.env.get("DASHBOARD_PASSCODE")!;

const ALLOWED = new Set([
  "customers",
  "bookings",
  "booking_services",
  "technicians",
  "services",
  "technician_time_off",
  "salon_hours",
  "technician_links",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { table, query, passcode } = await req.json();

    if (passcode !== DASHBOARD_PASSCODE) return json({ error: "unauthorized" }, 401);
    if (typeof table !== "string" || !ALLOWED.has(table)) return json({ error: "forbidden_table" }, 403);

    const qs = typeof query === "string" ? query : "";
    if (/[^\w\s=&.,:()\-*%+@]/.test(qs.replace(/%[0-9A-Fa-f]{2}/g, ""))) {
      return json({ error: "bad_query" }, 400);
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });

    const data = await r.json().catch(() => ([]));
    return json(data, r.ok ? 200 : r.status);
  } catch (e) {
    console.error("dashboard_read_error", String(e));
    return json({ error: "server_error" }, 500);
  }
});
