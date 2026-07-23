// ============================================================
// _shared/authz.ts
// Single authorization boundary for the passcode-gated dashboard.
// Used by BOTH dashboard-read and dashboard-write — this is the one
// authoritative place that decides which salon a request may touch, and
// (as of this version) which TIER of access the passcode used grants.
//
// Two passcodes now exist per salon: an Owner passcode (full access) and
// an optional Staff passcode (Today/Week/Aivy only — enforced here, not
// just hidden in the UI). verify_dashboard_passcode returns which tier
// matched ('owner' | 'staff' | null), and every table/action below can be
// marked ownerOnly to require the owner tier specifically.
//
// Does NOT govern the public website — that remains RLS-governed via
// the anon key and never calls these Edge Functions at all.
//
// NOTE: this ENTITY_REGISTRY is a separate copy from dashboard-write's —
// they are not shared code (two independent Edge Functions). Adding a
// table to one does NOT add it to the other; this was the exact bug that
// made website_settings/website_gallery_images writable but silently
// unreadable. Any future table needs adding to BOTH registries, not just
// one — and now that also applies to the ownerOnly flag.
//
// walkin_queue: NOT ownerOnly — Staff already has Today access, and the
// whole point of the queue is that front-desk staff can see who's
// waiting, not just the owner.
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function hasOwn(registry: Record<string, unknown>, key: unknown): boolean {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(registry, key);
}

type EntityConfig =
  | { kind: "direct"; salonCol: string; payrollGated?: boolean; ownerOnly?: boolean }
  | { kind: "via"; parent: string; key: string; payrollGated?: boolean; ownerOnly?: boolean }
  | { kind: "self" };

const ENTITY_REGISTRY: Record<string, EntityConfig> = {
  customers:               { kind: "direct", salonCol: "salon_id" },
  bookings:                { kind: "direct", salonCol: "salon_id" },
  technicians:              { kind: "direct", salonCol: "salon_id" },
  services:                 { kind: "direct", salonCol: "salon_id" },
  technician_time_off:     { kind: "direct", salonCol: "salon_id" },
  salon_hours:              { kind: "direct", salonCol: "salon_id" },
  technician_links:        { kind: "direct", salonCol: "salon_id" },
  payments:                 { kind: "direct", salonCol: "salon_id" },
  technician_compensation: { kind: "direct", salonCol: "salon_id", payrollGated: true, ownerOnly: true },
  payroll_periods:          { kind: "direct", salonCol: "salon_id", payrollGated: true, ownerOnly: true },
  website_settings:         { kind: "direct", salonCol: "salon_id", ownerOnly: true },
  website_gallery_images:   { kind: "direct", salonCol: "salon_id", ownerOnly: true },
  service_category_images:  { kind: "direct", salonCol: "salon_id", ownerOnly: true },
  walkin_queue:             { kind: "direct", salonCol: "salon_id" },

  technician_hours:        { kind: "via", parent: "technicians", key: "technician_id" },
  technician_services:     { kind: "via", parent: "technicians", key: "technician_id" },
  booking_services:        { kind: "via", parent: "bookings", key: "booking_id" },
  payroll_period_hours:    { kind: "via", parent: "payroll_periods", key: "payroll_period_id", payrollGated: true, ownerOnly: true },
  payroll_period_totals:   { kind: "via", parent: "payroll_periods", key: "payroll_period_id", payrollGated: true, ownerOnly: true },

  salons: { kind: "self" },
};

const PAYROLL_TABLES: Set<string> = new Set(
  Object.entries(ENTITY_REGISTRY)
    .filter(([, cfg]) => (cfg as { payrollGated?: boolean }).payrollGated)
    .map(([name]) => name),
);

// ---------- Passcode / PIN verification -----

async function verifyPasscode(salonId: string | undefined, passcode: string): Promise<string | null> {
  if (!salonId) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_dashboard_passcode`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_salon_id: salonId, p_passcode: passcode }),
  });
  if (!r.ok) return null;
  const tier = await r.json().catch(() => null);
  return typeof tier === "string" ? tier : null;
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

async function resolveAuthScope(
  claimedSalonId: string | undefined,
  passcode: string,
): Promise<{ scope: Set<string>; tier: string } | null> {
  const tier = await verifyPasscode(claimedSalonId, passcode);
  if (!tier) return null;
  return { scope: new Set([claimedSalonId!]), tier };
}

// ---------- Low-level fetch primitives ----

async function fetchIdsWhere(table: string, filter: string): Promise<string[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&${filter}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows.map((row: Record<string, unknown>) => row.id).filter(Boolean) as string[] : [];
}

function scopeFilter(col: string, scope: Set<string>): string {
  const ids = [...scope];
  return ids.length === 1 ? `${col}=eq.${ids[0]}` : `${col}=in.(${ids.join(",")})`;
}

// ---------- Read side: two-step ID resolution (no PostgREST embeds) ------

type ScopedQueryResult =
  | { ok: true; qs: string; reason: string }
  | { ok: false; empty: true; reason: string }
  | { ok: false; empty: false; reason: string };

function stripParam(qs: string, key: string): string {
  return (qs || "")
    .split("&")
    .filter((p) => p.length > 0 && !p.startsWith(`${key}=`))
    .join("&");
}

function mergeQuery(qs: string, forced: string): string {
  return [forced, qs].filter((p) => p.length > 0).join("&");
}

function extractKeyValues(qs: string, key: string): string[] | null {
  const match = (qs || "").split("&").find((p) => p.startsWith(`${key}=`));
  if (!match) return null;
  const value = match.slice(key.length + 1);
  if (value.startsWith("eq.")) return [value.slice(3)];
  if (value.startsWith("in.(") && value.endsWith(")")) {
    return value.slice(4, -1).split(",").filter(Boolean);
  }
  return [];
}

async function buildScopedQuery(
  table: string,
  rawClientQuery: string,
  scope: Set<string>,
): Promise<ScopedQueryResult> {
  if (!hasOwn(ENTITY_REGISTRY, table)) return { ok: false, empty: false, reason: "entity_not_registered" };
  const cfg = ENTITY_REGISTRY[table];

  const clientQuery = stripParam(rawClientQuery, "select");

  if (cfg.kind === "self") {
    const stripped = stripParam(clientQuery, "id");
    return { ok: true, qs: mergeQuery(stripped, scopeFilter("id", scope)), reason: "direct_ownership" };
  }

  if (cfg.kind === "direct") {
    const stripped = stripParam(clientQuery, cfg.salonCol);
    return { ok: true, qs: mergeQuery(stripped, scopeFilter(cfg.salonCol, scope)), reason: "direct_ownership" };
  }

  const parentCfg = hasOwn(ENTITY_REGISTRY, cfg.parent) ? ENTITY_REGISTRY[cfg.parent] : undefined;
  const parentSalonFilter =
    parentCfg && parentCfg.kind === "direct" ? scopeFilter(parentCfg.salonCol, scope) : scopeFilter("id", scope);

  const requestedIds = extractKeyValues(clientQuery, cfg.key);
  let finalIds: string[];
  let reason: string;

  if (requestedIds) {
    if (requestedIds.length === 0) return { ok: false, empty: true, reason: "no_owned_rows" };
    finalIds = await fetchIdsWhere(cfg.parent, `id=in.(${requestedIds.join(",")})&${parentSalonFilter}`);
    reason = "direct_ownership";
  } else {
    finalIds = await fetchIdsWhere(cfg.parent, parentSalonFilter);
    reason = "inherited_ownership";
  }

  if (finalIds.length === 0) {
    return { ok: false, empty: true, reason: "no_owned_rows" };
  }

  const stripped = stripParam(clientQuery, cfg.key);
  return { ok: true, qs: mergeQuery(stripped, `${cfg.key}=in.(${finalIds.join(",")})`), reason };
}

function logAuthz(
  kind: "read" | "write",
  target: string,
  scope: Set<string>,
  result: { decision?: "allow" | "deny"; reason: string; salonId?: string | null; path?: string[] },
): void {
  console.log(
    JSON.stringify({
      authz: true,
      kind,
      target,
      auth_scope: [...scope],
      decision: result.decision ?? "allow",
      reason: result.reason,
      resolved_salon_id: result.salonId ?? null,
      path: result.path ?? null,
    }),
  );
}

// ============================================================
// Supabase Edge Function: dashboard-read
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Velour-Tier",
};

const json = (body: unknown, status = 200, tier?: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", ...(tier ? { "X-Velour-Tier": tier } : {}) },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { table, query, passcode, salon_id, payroll_pin } = await req.json();

    const auth = await resolveAuthScope(salon_id, passcode);
    if (!auth) return json({ error: "unauthorized" }, 401);
    const { scope, tier } = auth;
    const AUTH_SALON = [...scope][0];

    if (typeof table !== "string" || !hasOwn(ENTITY_REGISTRY, table)) {
      logAuthz("read", String(table), scope, { decision: "deny", reason: "entity_not_registered" });
      return json({ error: "forbidden_table" }, 403, tier);
    }

    const entityCfg = ENTITY_REGISTRY[table] as { ownerOnly?: boolean };
    if (entityCfg.ownerOnly && tier !== "owner") {
      logAuthz("read", table, scope, { decision: "deny", reason: "owner_only_table" });
      return json({ error: "owner_only_table" }, 403, tier);
    }

    if (PAYROLL_TABLES.has(table)) {
      if (!(await verifyPayrollPin(AUTH_SALON, payroll_pin))) {
        return json({ error: "payroll_pin_required" }, 401, tier);
      }
    }

    const qs = typeof query === "string" ? query : "";
    if (/[^\w\s=&.,:()\\-*%+@]/.test(qs.replace(/%[0-9A-Fa-f]{2}/g, ""))) {
      return json({ error: "bad_query" }, 400, tier);
    }

    const scoped = await buildScopedQuery(table, qs, scope);

    if (!scoped.ok) {
      if (scoped.empty) {
        logAuthz("read", table, scope, { decision: "allow", reason: scoped.reason });
        return json([], 200, tier);
      }
      logAuthz("read", table, scope, { decision: "deny", reason: scoped.reason });
      return json({ error: "forbidden_table" }, 403, tier);
    }

    logAuthz("read", table, scope, { decision: "allow", reason: scoped.reason });

    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${scoped.qs}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });

    const data = await r.json().catch(() => ([]));
    return json(data, r.ok ? 200 : r.status, tier);
  } catch (e) {
    console.error("dashboard_read_error", String(e));
    return json({ error: "server_error" }, 500);
  }
});
