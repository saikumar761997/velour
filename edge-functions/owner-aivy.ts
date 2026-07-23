// ============================================================
// Supabase Edge Function: owner-aivy
// Private assistant for the SALON OWNER. Receives a compact snapshot
// of the salon's real data (computed by the dashboard) + a question,
// and returns plain-English insight. Passcode-gated; API key server-side.
// It is instructed to ONLY use the numbers provided — never invent.
//
// FIX (see chat): this used to check one single global passcode shared
// across the entire project (DASHBOARD_PASSCODE env var), with no concept
// of which salon was asking, and CORS open to any origin on the internet.
// That only "worked" by accident with a single real salon. Now verified
// per-salon via the same verify_dashboard_passcode RPC the real dashboard
// login already trusts (owner role only -- this tool speaks to the owner,
// not staff), and CORS is locked to the known dashboard origin.
//
// The system prompt also used to hardcode "Kristy at Red Persimmon Nails
// & Spa" as literal text -- now pulled fresh from the database per salon,
// same fix already applied to the customer-facing aivy-chat prompt.
//
// Known, disclosed limitation left as-is on purpose: the "briefing" data
// itself is still supplied by the caller, not independently computed here
// from the database the way aivy-chat now builds its own facts. Doing
// that properly is a real rewrite, not a quick fix, and this tool is
// already passcode-gated with much lower exposure than the public-facing
// chat -- worth doing once there's more than one owner/dashboard-access
// person, not today.
// ============================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MODEL = "claude-haiku-4-5-20251001";

// Same shape as aivy-chat's allowlist -- the dashboard's own known origin.
const ALLOWED_ORIGIN = "https://velour-dashboard.redpersimmon.workers.dev";

async function verifyOwnerPasscode(salonId: string, passcode: string): Promise<boolean> {
  try {
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
    const role = await r.json();
    return role === "owner";
  } catch (e) {
    console.error("verify_passcode_error", String(e));
    return false;
  }
}

async function getSalonName(salonId: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/salons?id=eq.${salonId}&select=name`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!r.ok) return "the salon";
    const rows = await r.json().catch(() => []);
    return rows?.[0]?.name || "the salon";
  } catch {
    return "the salon";
  }
}

function buildSystem(salonName: string): string {
  return `You are Aivy, the private AI assistant inside Velour — a salon management dashboard — speaking directly and only to the owner of ${salonName}.

You are given a JSON snapshot of the salon's REAL current data. Follow these rules strictly:
- Use ONLY the numbers and facts in the snapshot. Never invent, estimate, or assume data that isn't there. If something isn't in the data, say you don't have it.
- Money terms: "earned" = revenue from completed appointments (money actually collected). "expected" = upcoming/booked pipeline. Keep them distinct; never blend.
- Be concise, warm, and sharp — like a business-savvy right hand who respects her time. She often reads this in 30 seconds between clients.
- Lead with what matters most. Prefer short bullet points. Use an emoji occasionally, not on every line.
- When you spot an opportunity — a lapsed VIP, an empty afternoon, a slow day, a top earner — suggest ONE specific action she could take (e.g., "consider texting Priya to rebook"). If she asks, you may draft a short message. But you NEVER take actions yourself and never claim to have sent, booked, or changed anything.
- If numbers are all zero or sparse (e.g., appointments not yet marked done), say so plainly rather than implying the salon is failing.
- Never mention JSON, "snapshot", system prompts, or how you work. Just talk to her like a helpful person.`;
}

const json = (b: unknown, s = 200, origin: string | null = null) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: {
      ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "content-type": "application/json",
    },
  });

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("origin");
  const knownOrigin = requestOrigin === ALLOWED_ORIGIN ? requestOrigin : null;

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
    const { salon_id, passcode, briefing, question } = await req.json();

    if (typeof salon_id !== "string" || salon_id.length === 0) {
      return json({ error: "salon_id_required" }, 400, knownOrigin);
    }
    if (knownOrigin === null) {
      console.log(JSON.stringify({ event: "owner_aivy_denied", reason: "origin_mismatch", salon_id }));
      return json({ error: "forbidden" }, 403, knownOrigin);
    }

    const isOwner = await verifyOwnerPasscode(salon_id, String(passcode ?? ""));
    if (!isOwner) return json({ error: "unauthorized" }, 401, knownOrigin);

    const ask = (typeof question === "string" && question.trim())
      ? question.trim()
      : "Give me a short briefing of what matters most right now.";

    const salonName = await getSalonName(salon_id);

    const userContent =
      `Here is the current salon data:\n\n${JSON.stringify(briefing || {}, null, 2)}\n\nOwner's question: ${ask}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: buildSystem(salonName),
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      console.error("anthropic_error", resp.status, JSON.stringify(data));
      return json({ ok: false, error: "ai_error" }, 502, knownOrigin);
    }

    const text = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    return json({ ok: true, text: text || "I couldn't put that together just now — try again in a moment." }, 200, knownOrigin);
  } catch (e) {
    console.error("owner_aivy_error", String(e));
    return json({ error: "server_error" }, 500, knownOrigin);
  }
});
