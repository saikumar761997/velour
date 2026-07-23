// ============================================================
// Supabase Edge Function: aivy-chat
// The browser calls THIS function; this function calls Anthropic.
// The API key stays here on the server and never reaches visitors.
//
// Security layers, applied in order (frozen design, approved):
//   1. salon_id allowlist check (defensive -- salon_id is Edge-Function-
//      controlled today, not user input, but validated anyway)
//   2. Turnstile verification (once per session) OR a valid signed trust
//      token from a prior verified session -- proves "a real browser
//      solved a challenge," not an ongoing behavior claim
//   3. Rate limiting via the generic check_and_increment_rate_limit RPC:
//      session counter (primary conversation budget), IP counter
//      (shared-key abuse backstop), salon counter (tenant-wide circuit
//      breaker) -- all three checked together, AND'd
//   4. Only then: call Anthropic
//
// Failure policy (frozen):
//   - Turnstile unavailable -> fail OPEN (log it, allow the message;
//     rate limiter is still the backstop)
//   - Rate limiter / Supabase unavailable -> fail CLOSED (friendly
//     fallback, never silently allow)
//   - Anthropic unavailable -> existing friendly fallback, unchanged
//
// FIX (see chat, this session): SALON_ORIGINS still pointed at the old
// velour-platform domain after the Cloudflare project was renamed to
// velour-website. Since the origin check is a hard match, every real
// customer message was being silently rejected with a 403 on the live
// site until this was caught and corrected.
// ============================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY")!;
const RATE_LIMIT_TOKEN_SECRET = Deno.env.get("RATE_LIMIT_TOKEN_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const LIMITS = {
  session: { windowSeconds: 30 * 60, max: 15 },
  ip:      { windowSeconds: 60 * 60, max: 150 },
  salon:   { windowSeconds: 24 * 60 * 60, max: 1000 },
};

const TRUST_TOKEN_LIFETIME_SECONDS = 25 * 60;

const SALON_ORIGINS: Record<string, string> = {
  "a0000000-0000-0000-0000-000000000001": "https://velour-website.redpersimmon.workers.dev",
  "d0000000-0000-0000-0000-000000000001": "https://velour-website.redpersimmon.workers.dev",
};

const DOW_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DOW_LABEL: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};
const CATEGORY_LABEL: Record<string, string> = {
  nail_care: "natural nail care", enhancements: "nail enhancements",
  polish: "polish services", lashes: "lash extensions & microblading",
  waxing: "waxing",
};

async function sbGet(table: string, qs: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

function summarizeHours(rows: any[]): string {
  const byDow: Record<string, any> = Object.fromEntries(rows.map((r) => [r.day_of_week, r]));
  const lines: string[] = [];
  let i = 0;
  while (i < DOW_ORDER.length) {
    const dow = DOW_ORDER[i];
    const row = byDow[dow];
    if (!row || !row.is_open) { i++; continue; }
    let j = i;
    while (
      j + 1 < DOW_ORDER.length &&
      byDow[DOW_ORDER[j + 1]]?.is_open &&
      byDow[DOW_ORDER[j + 1]].open_time === row.open_time &&
      byDow[DOW_ORDER[j + 1]].close_time === row.close_time
    ) j++;
    const label = j > i ? `${DOW_LABEL[dow]}-${DOW_LABEL[DOW_ORDER[j]]}` : DOW_LABEL[dow];
    lines.push(`${label} ${fmtTime(row.open_time)}-${fmtTime(row.close_time)}`);
    i = j + 1;
  }
  return lines.join(" | ") || "Please call for current hours";
}

async function buildSystemPrompt(salonId: string): Promise<string> {
  const [salons, hours, services, techs] = await Promise.all([
    sbGet("salons", `id=eq.${salonId}&select=name,phone,email,address,address2,city,state,zip`),
    sbGet("salon_hours", `salon_id=eq.${salonId}&select=day_of_week,is_open,open_time,close_time`),
    sbGet("services", `salon_id=eq.${salonId}&active=eq.true&archived_at=is.null&select=category,name,price,duration_minutes&order=category,name`),
    sbGet("technicians", `salon_id=eq.${salonId}&active=eq.true&select=id,name,available_days&order=name`),
  ]);
  const techIds = techs.map((t: any) => t.id);
  const techSvcRows = techIds.length
    ? await sbGet("technician_services", `technician_id=in.(${techIds.join(",")})&select=technician_id,services(category)`)
    : [];

  const salon = salons[0] || {};
  const fullAddress = [salon.address, salon.address2].filter(Boolean).join(", ");
  const cityLine = [salon.city, salon.state, salon.zip].filter(Boolean).join(", ");

  const svcByCat: Record<string, any[]> = {};
  services.forEach((s: any) => { (svcByCat[s.category || "other"] ||= []).push(s); });
  const svcText = Object.entries(svcByCat).map(([cat, list]) => {
    const label = (CATEGORY_LABEL[cat] || cat).toUpperCase();
    const lines = list.map((s) => `- ${s.name} $${Number(s.price).toFixed(0)} (~${s.duration_minutes} min)`).join("\n");
    return `${label}:\n${lines}`;
  }).join("\n\n");

  const catsByTech: Record<string, Set<string>> = {};
  techSvcRows.forEach((r: any) => {
    const cat = r.services?.category;
    if (!cat) return;
    (catsByTech[r.technician_id] ||= new Set()).add(cat);
  });
  const techText = techs.map((t: any) => {
    const days = Array.isArray(t.available_days) && t.available_days.length
      ? t.available_days.map((d: string) => DOW_LABEL[d] || d).join("/")
      : "Every day";
    const cats = [...(catsByTech[t.id] || [])].map((c) => CATEGORY_LABEL[c] || c);
    const specialty = cats.length ? cats.join(", ") : "General services";
    return `- ${t.name.toUpperCase()} · ${days} · ${specialty}`;
  }).join("\n");

  return `You are Aivy, the AI assistant for ${salon.name || "the salon"} in ${cityLine || "the area"}.

TONE: Warm and helpful, but speak like a knowledgeable staff member, not a hype machine. Confident, concise, plainly professional. 2-3 sentences max. End with a clear next step when relevant. At most one emoji per reply, and only when it genuinely fits (💅 ✨) -- never stack multiple, never use one in every message.

ABOUT:
${salon.name || ""} -- ${fullAddress}${cityLine ? ", " + cityLine : ""}
${salon.phone ? `Phone: ${salon.phone}` : ""}${salon.email ? ` | Email: ${salon.email}` : ""}
Walk-ins always welcome. Gift certificates available. Free parking.

HOURS: ${summarizeHours(hours)}

SERVICES & PRICING (live, always current -- if something isn't listed here, it isn't currently offered):
${svcText}

TECHNICIANS (name · available days · specialties):
${techText}

BOOKING -- HOW IT WORKS ON OUR WEBSITE:
We have our own booking system -- no third-party scheduler. When a customer wants to book:
"To book, scroll to our Services section, tap the + button next to the service you want, choose your technician, then tap Book Appointment. You can also tap the Book Step-by-Step button right here in this chat."
Always mention the technician's available days when recommending one.
If services need different technicians, guide the customer to book each separately.

COMMON QUESTIONS:
- Payment: cash and all major credit/debit cards.
- Typical duration: manicure ~30-45 min, pedicure ~45-60 min, full acrylic ~60-90 min, lash extensions ~90-120 min, microblading ~2 hrs.
- Reschedule/cancel: point them to the Manage Appointment link in their confirmation email, or have them call.
- Allergies: ask them to note it when booking so the technician is prepared.
- Kids: mention the children's pricing under Additional if a parent asks.

RULES:
- Plain conversational sentences only -- no markdown formatting, no bullet dashes, no bold/italic.
- If a customer names a specific technician they want, always honor that -- never redirect them to someone else, even if another technician usually handles that service.
- Never quote walk-in wait times.
- Microblading -- recommend a phone consultation rather than booking directly.
- Anything you can't help with -- direct them to call${salon.phone ? " " + salon.phone : ""}${salon.email ? " or email " + salon.email : ""}.`;
}

const json = (body: unknown, status = 200, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "content-type": "application/json",
    },
  });

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields, ts: new Date().toISOString() }));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashIp(ip: string): Promise<string> {
  return hmacHex(RATE_LIMIT_TOKEN_SECRET, `ip:${ip}`);
}

async function mintTrustToken(sessionId: string, salonId: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + TRUST_TOKEN_LIFETIME_SECONDS;
  const payload = `${sessionId}.${salonId}.${expiresAt}`;
  const sig = await hmacHex(RATE_LIMIT_TOKEN_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifyTrustToken(token: string, sessionId: string, salonId: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [tokSession, tokSalon, tokExpiry, tokSig] = parts;
  if (tokSession !== sessionId || tokSalon !== salonId) return false;
  const expiresAt = parseInt(tokExpiry, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expectedSig = await hmacHex(RATE_LIMIT_TOKEN_SECRET, `${tokSession}.${tokSalon}.${tokExpiry}`);
  return expectedSig === tokSig;
}

async function verifyTurnstile(token: string, remoteIp: string): Promise<{ ok: boolean; failedOpen: boolean }> {
  try {
    const body = new URLSearchParams();
    body.set("secret", TURNSTILE_SECRET_KEY);
    body.set("response", token);
    if (remoteIp) body.set("remoteip", remoteIp);

    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });

    if (!r.ok) {
      log("turnstile_unavailable", { status: r.status });
      return { ok: true, failedOpen: true };
    }

    const data = await r.json();
    return { ok: data.success === true, failedOpen: false };
  } catch (e) {
    log("turnstile_unavailable", { error: String(e) });
    return { ok: true, failedOpen: true };
  }
}

async function checkRateLimit(
  salonId: string,
  sessionId: string,
  hashedIp: string,
): Promise<{ allowed: boolean; checks: unknown[] } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_and_increment_rate_limit`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_salon_id: salonId,
        p_action: "aivy_message",
        p_checks: [
          { key_type: "session", key_value: sessionId, window_seconds: LIMITS.session.windowSeconds, max_count: LIMITS.session.max },
          { key_type: "ip", key_value: hashedIp, window_seconds: LIMITS.ip.windowSeconds, max_count: LIMITS.ip.max },
          { key_type: "salon", key_value: salonId, window_seconds: LIMITS.salon.windowSeconds, max_count: LIMITS.salon.max },
        ],
      }),
    });

    if (!r.ok) {
      log("rate_limiter_unavailable", { status: r.status });
      return null;
    }

    return await r.json();
  } catch (e) {
    log("rate_limiter_unavailable", { error: String(e) });
    return null;
  }
}

const FALLBACK_REPLY = "I'm having a moment! Please call (603) 621-7469 — we'd love to help 💅";

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const knownOrigin = Object.values(SALON_ORIGINS).includes(requestOrigin ?? "") ? requestOrigin : null;

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...(knownOrigin ? { "Access-Control-Allow-Origin": knownOrigin } : {}),
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, knownOrigin);

  try {
    const { messages, salon_id, session_id, turnstile_token, trust_token } = await req.json();

    if (typeof salon_id !== "string" || !(salon_id in SALON_ORIGINS)) {
      log("aivy_denied", { reason: "unknown_salon" });
      return json({ reply: FALLBACK_REPLY }, 200, knownOrigin);
    }

    if (knownOrigin !== SALON_ORIGINS[salon_id]) {
      log("aivy_denied", { reason: "origin_mismatch", salon_id });
      return json({ error: "forbidden" }, 403, knownOrigin);
    }

    if (typeof session_id !== "string" || session_id.length === 0) {
      log("aivy_denied", { reason: "missing_session_id", salon_id });
      return json({ reply: FALLBACK_REPLY }, 200, knownOrigin);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages_required" }, 400, knownOrigin);
    }

    let trustedForResponse: string | null = null;

    if (typeof trust_token === "string" && trust_token.length > 0) {
      const valid = await verifyTrustToken(trust_token, session_id, salon_id);
      if (!valid) {
        log("aivy_denied", { reason: "invalid_or_expired_trust_token", salon_id });
        return json({ reply: FALLBACK_REPLY, require_turnstile: true }, 200, knownOrigin);
      }
      trustedForResponse = trust_token;
    } else if (typeof turnstile_token === "string" && turnstile_token.length > 0) {
      const remoteIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
      const { ok, failedOpen } = await verifyTurnstile(turnstile_token, remoteIp);
      if (!ok) {
        log("aivy_denied", { reason: "turnstile_failed", salon_id });
        return json({ reply: FALLBACK_REPLY, require_turnstile: true }, 200, knownOrigin);
      }
      if (failedOpen) log("aivy_allowed_turnstile_failed_open", { salon_id });
      trustedForResponse = await mintTrustToken(session_id, salon_id);
    } else {
      log("aivy_denied", { reason: "no_turnstile_or_trust_token", salon_id });
      return json({ reply: FALLBACK_REPLY, require_turnstile: true }, 200, knownOrigin);
    }

    const remoteIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const hashedIp = await hashIp(remoteIp);

    const rateResult = await checkRateLimit(salon_id, session_id, hashedIp);
    if (rateResult === null) {
      log("aivy_denied", { reason: "rate_limiter_unavailable", salon_id });
      return json({ reply: FALLBACK_REPLY }, 200, knownOrigin);
    }
    if (!rateResult.allowed) {
      log("aivy_denied", { reason: "rate_limited", salon_id, checks: rateResult.checks });
      return json({ reply: FALLBACK_REPLY }, 200, knownOrigin);
    }

    const systemPrompt = await buildSystemPrompt(salon_id);

    const trimmed = messages.slice(-12).map((m: { role?: string; content?: unknown }) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? "").slice(0, 2000),
    }));

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: trimmed,
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("anthropic_error", r.status, detail);
      return json({ reply: FALLBACK_REPLY, trust_token: trustedForResponse }, 200, knownOrigin);
    }

    const data = await r.json();
    const reply = data?.content?.[0]?.text || FALLBACK_REPLY;
    return json({ reply, trust_token: trustedForResponse }, 200, knownOrigin);
  } catch (e) {
    console.error("aivy_chat_error", String(e));
    return json({ reply: FALLBACK_REPLY }, 200, knownOrigin);
  }
});
