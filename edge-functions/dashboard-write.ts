// ============================================================
// _shared/authz.ts (inlined — see chat for why)
// ============================================================

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function hasOwn(registry: Record<string, unknown>, key: unknown): boolean {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(registry, key);
}

type EntityConfig =
  | { kind: "direct"; salonCol: string; payrollGated?: boolean }
  | { kind: "via"; parent: string; key: string; payrollGated?: boolean }
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
  technician_compensation: { kind: "direct", salonCol: "salon_id", payrollGated: true },
  payroll_periods:          { kind: "direct", salonCol: "salon_id", payrollGated: true },
  website_settings:         { kind: "direct", salonCol: "salon_id" },
  website_gallery_images:   { kind: "direct", salonCol: "salon_id" },
  service_category_images:  { kind: "direct", salonCol: "salon_id" },
  walkin_queue:             { kind: "direct", salonCol: "salon_id" },

  technician_hours:        { kind: "via", parent: "technicians", key: "technician_id" },
  technician_services:     { kind: "via", parent: "technicians", key: "technician_id" },
  booking_services:        { kind: "via", parent: "bookings", key: "booking_id" },
  payroll_period_hours:    { kind: "via", parent: "payroll_periods", key: "payroll_period_id", payrollGated: true },
  payroll_period_totals:   { kind: "via", parent: "payroll_periods", key: "payroll_period_id", payrollGated: true },

  salons: { kind: "self" },
};

type ActionConfig =
  | { rpc: string; kind: "salonArg"; arg: string; payroll?: boolean; ownerOnly?: boolean }
  | { rpc: string; kind: "recordBind"; arg: string; entity: string; payroll?: boolean; ownerOnly?: boolean; salonArg?: string };

// NOTE (fix, see chat): set_queue_status is the one recordBind action whose
// underlying RPC also requires p_salon_id as a real, non-defaulted argument
// (every other recordBind RPC only takes the record id). Previously nothing
// ever supplied that argument — not the client, not this file — so every
// call to it failed with a Postgres "no matching function signature" error,
// which the dashboard's own try/catch around this specific call swallowed
// silently. Net effect: no walk-in queue entry has ever successfully
// changed status (waiting/in_service/done/left) since the feature shipped.
// `salonArg` here tells the write handler below to inject the *already
// verified* salon id for this record after authorization succeeds — same
// trust boundary as every other action, just supplying the extra argument
// this one RPC happens to need.
const ACTION_REGISTRY: Record<string, ActionConfig> = {
  mark_status:          { rpc: "mark_booking_status",       kind: "recordBind", arg: "p_booking", entity: "bookings" },
  reschedule:            { rpc: "reschedule_booking",        kind: "recordBind", arg: "p_booking", entity: "bookings" },
  checkout:              { rpc: "checkout_booking",          kind: "recordBind", arg: "p_booking", entity: "bookings" },
  save_notes:            { rpc: "update_customer_notes",     kind: "recordBind", arg: "p_customer", entity: "customers" },
  reset_tech_link:      { rpc: "reset_tech_token",           kind: "recordBind", arg: "p_tech", entity: "technicians", ownerOnly: true },
  clear_timeoff:         { rpc: "clear_technician_time_off",  kind: "recordBind", arg: "p_id", entity: "technician_time_off" },
  set_queue_status:      { rpc: "set_queue_status",           kind: "recordBind", arg: "p_queue_id", entity: "walkin_queue", salonArg: "p_salon_id" },
  preview_payroll:       { rpc: "calculate_payroll_preview",  kind: "recordBind", arg: "p_payroll_period_id", entity: "payroll_periods", payroll: true, ownerOnly: true },
  close_payroll_period:  { rpc: "close_payroll_period",       kind: "recordBind", arg: "p_payroll_period_id", entity: "payroll_periods", payroll: true, ownerOnly: true },
  update_payroll_hours:  { rpc: "update_payroll_hours",       kind: "recordBind", arg: "p_payroll_period_id", entity: "payroll_periods", payroll: true, ownerOnly: true },
  reopen_payroll_period: { rpc: "reopen_payroll_period",      kind: "recordBind", arg: "p_payroll_period_id", entity: "payroll_periods", payroll: true, ownerOnly: true },
  set_timeoff:              { rpc: "set_technician_time_off", kind: "salonArg", arg: "p_salon" },
  close_salon:               { rpc: "close_salon_day",         kind: "salonArg", arg: "p_salon" },
  reopen_salon:              { rpc: "reopen_salon_day",        kind: "salonArg", arg: "p_salon" },
  create_booking:            { rpc: "create_booking",          kind: "salonArg", arg: "p_salon" },
  set_compensation:          { rpc: "set_technician_compensation", kind: "salonArg", arg: "p_salon_id", payroll: true, ownerOnly: true },
  create_payroll_period:     { rpc: "create_payroll_period",   kind: "salonArg", arg: "p_salon_id", payroll: true, ownerOnly: true },
  change_passcode:           { rpc: "change_dashboard_passcode", kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_staff_passcode:        { rpc: "set_staff_passcode",      kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_payroll_pin:           { rpc: "set_payroll_pin",         kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  get_settings_status:       { rpc: "get_settings_status",     kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  update_business_info:      { rpc: "update_salon_info",       kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  update_business_hours:     { rpc: "update_salon_hours",      kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  upsert_service:            { rpc: "upsert_service",          kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_service_active:        { rpc: "set_service_active",      kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  archive_service:           { rpc: "archive_service",         kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_service_category_image:{ rpc: "set_service_category_image", kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  upsert_technician:         { rpc: "upsert_technician",       kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_technician_active:     { rpc: "set_technician_active",   kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  archive_technician:        { rpc: "archive_technician",      kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  set_technician_services:   { rpc: "set_technician_services", kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  update_technician_hours:   { rpc: "update_technician_hours", kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  update_website_settings:          { rpc: "update_website_settings",          kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  add_website_gallery_image:        { rpc: "add_website_gallery_image",        kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  update_website_gallery_image:     { rpc: "update_website_gallery_image",     kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  archive_website_gallery_image:    { rpc: "archive_website_gallery_image",    kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
  upload_website_image:             { rpc: "__handled_specially__",             kind: "salonArg", arg: "p_salon_id", ownerOnly: true },
};

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

async function fetchOneCol(table: string, col: string, id: string): Promise<string | null> {
  if (!id) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${col}&id=eq.${id}&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? (rows[0][col] ?? null) : null;
}

type AuthzResult = { decision: "allow" | "deny"; reason: string; salonId: string | null; path: string[] };

const MAX_RESOLUTION_DEPTH = 5;

async function resolveSalonForEntity(
  entity: string,
  id: string,
  path: string[] = [],
): Promise<{ salonId: string | null; path: string[] }> {
  const nextPath = [...path, entity];
  if (nextPath.length > MAX_RESOLUTION_DEPTH) {
    return { salonId: null, path: nextPath };
  }
  if (!hasOwn(ENTITY_REGISTRY, entity)) return { salonId: null, path: nextPath };
  const cfg = ENTITY_REGISTRY[entity];
  if (cfg.kind === "self") return { salonId: id, path: nextPath };
  if (cfg.kind === "direct") {
    const salonId = await fetchOneCol(entity, cfg.salonCol, id);
    return { salonId, path: nextPath };
  }
  const parentKeyVal = await fetchOneCol(entity, cfg.key, id);
  if (!parentKeyVal) return { salonId: null, path: nextPath };
  return resolveSalonForEntity(cfg.parent, parentKeyVal, nextPath);
}

async function authorizeRecordBind(
  entity: string,
  recordId: string | undefined,
  scope: Set<string>,
): Promise<AuthzResult> {
  if (!hasOwn(ENTITY_REGISTRY, entity)) {
    return { decision: "deny", reason: "entity_not_registered", salonId: null, path: [entity] };
  }
  if (!recordId) {
    return { decision: "deny", reason: "missing_record_id", salonId: null, path: [entity] };
  }
  const { salonId, path } = await resolveSalonForEntity(entity, recordId);
  if (!salonId) {
    return { decision: "deny", reason: "record_not_found", salonId: null, path };
  }
  if (!scope.has(salonId)) {
    return { decision: "deny", reason: "salon_mismatch", salonId, path };
  }
  const reason = path.length > 1 ? "inherited_ownership" : "direct_ownership";
  return { decision: "allow", reason, salonId, path };
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

function sanitizeFileName(name: string): string {
  return (name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

async function uploadToStorage(path: string, contentType: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/website-media/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, error: `HTTP ${r.status}: ${body}` };
  }
  return { ok: true };
}

// ============================================================
// Supabase Edge Function: dashboard-write
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
    const { action, args, passcode, salon_id, payroll_pin } = await req.json();

    const auth = await resolveAuthScope(salon_id, passcode);
    if (!auth) return json({ error: "unauthorized" }, 401);
    const { scope, tier } = auth;
    const AUTH_SALON = [...scope][0];

    if (!hasOwn(ACTION_REGISTRY, action)) {
      logAuthz("write", String(action), scope, { decision: "deny", reason: "action_not_registered" });
      return json({ error: "unknown_action" }, 403, tier);
    }
    const cfg = ACTION_REGISTRY[action];

    if (cfg.ownerOnly && tier !== "owner") {
      logAuthz("write", action, scope, { decision: "deny", reason: "owner_only_action" });
      return json({ error: "owner_only_action" }, 403, tier);
    }

    if (cfg.payroll) {
      if (!(await verifyPayrollPin(AUTH_SALON, payroll_pin))) {
        return json({ error: "payroll_pin_required" }, 401, tier);
      }
    }

    const writeArgs: Record<string, unknown> = { ...(args || {}) };

    if (cfg.kind === "salonArg") {
      writeArgs[cfg.arg] = AUTH_SALON;
      logAuthz("write", action, scope, {
        decision: "allow",
        reason: "direct_ownership",
        salonId: AUTH_SALON,
        path: [action],
      });
    } else {
      const recordId = (args || {})[cfg.arg] as string | undefined;
      const result = await authorizeRecordBind(cfg.entity, recordId, scope);
      logAuthz("write", action, scope, result);
      if (result.decision !== "allow") {
        return json({ error: "cross_salon_denied" }, 403, tier);
      }
      // Fix (see chat): some recordBind RPCs — currently only set_queue_status
      // — also require the salon id as a real argument, not just the record
      // id. The record's salon was already resolved and verified by
      // authorizeRecordBind() above, so this is just supplying it to the RPC,
      // not a new trust decision — the authorization already happened.
      if (cfg.salonArg) {
        writeArgs[cfg.salonArg] = result.salonId;
      }
    }

    if (action === "upload_website_image") {
      const a = args || {};
      const kind = String(a.p_kind || "misc").replace(/[^a-z_]/g, "") || "misc";
      const contentType = String(a.p_content_type || "");
      const base64 = String(a.p_file_base64 || "");
      const fileName = sanitizeFileName(String(a.p_file_name || "upload"));

      if (!contentType.startsWith("image/")) {
        return json({ ok: false, error: "INVALID_FILE_TYPE" }, 400, tier);
      }
      if (!base64) {
        return json({ ok: false, error: "MISSING_FILE" }, 400, tier);
      }

      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      } catch {
        return json({ ok: false, error: "INVALID_FILE_ENCODING" }, 400, tier);
      }

      if (bytes.length > 5 * 1024 * 1024) {
        return json({ ok: false, error: "FILE_TOO_LARGE" }, 400, tier);
      }

      const path = `${AUTH_SALON}/${kind}/${Date.now()}-${fileName}`;
      const uploadResult = await uploadToStorage(path, contentType, bytes);
      if (!uploadResult.ok) {
        return json({ ok: false, error: uploadResult.error || "UPLOAD_FAILED" }, 500, tier);
      }

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/website-media/${path}`;
      return json({ ok: true, result: { url: publicUrl } }, 200, tier);
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${cfg.rpc}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(writeArgs),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return json({ ok: false, error: (data && (data.message || data.error)) || `HTTP ${r.status}` }, r.status, tier);
    }
    return json({ ok: true, result: data }, 200, tier);
  } catch (e) {
    console.error("dashboard_write_error", String(e));
    return json({ error: "server_error" }, 500);
  }
});
