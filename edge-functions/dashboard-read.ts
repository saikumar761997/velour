// ============================================================
// Supabase Edge Function: dashboard-read
// Read-only proxy for the staff dashboard. Per-salon passcode-gated,
// with a second, independent Payroll-PIN gate on payroll tables.
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

const LEGACY_DASHBOARD_PASSCODE = Deno.env.get("DASHBOARD_PASSCODE")!;

const ALLOWED = new Set([
  "customers",
  "bookings",
  "booking_services",
  "technicians",
  "services",
  "technician_time_off",
  "salon_hours",
  "technician_links",
  "technician_services",
  "technician_hours",
  "payments",
  "technician_compensation",
  "payroll_periods",
  "payroll_period_hours",
  "payroll_period_totals",
  "salons",
]);

const PAYROLL_TABLES = new Set([
  "technician_compensation",
  "payroll_periods",
  "payroll_period_hours",
  "payroll_period_totals",
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
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
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
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
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
    const { table, query, passcode, salon_id, payroll_pin } = await req.json();

    if (!(await verifyPasscode(salon_id, passcode))) return json({ error: "unauthorized" }, 401);
    if (typeof table !== "string" || !ALLOWED.has(table)) return json({ error: "forbidden_table" }, 403);

    if (PAYROLL_TABLES.has(table)) {
      if (!(await verifyPayrollPin(salon_id, payroll_pin))) {
        return json({ error: "payroll_pin_required" }, 401);
      }
    }

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
