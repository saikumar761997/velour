// ============================================================
// Supabase Edge Function: owner-aivy
// Private assistant for the SALON OWNER. Receives a compact snapshot
// of the salon's real data (computed by the dashboard) + a question,
// and returns plain-English insight. Passcode-gated; API key server-side.
// It is instructed to ONLY use the numbers provided — never invent.
// ============================================================

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const DASHBOARD_PASSCODE = Deno.env.get("DASHBOARD_PASSCODE")!;

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM = `You are Aivy, the private AI assistant inside Velour — a salon management dashboard — speaking directly and only to the salon owner (Kristy at Red Persimmon Nails & Spa).

You are given a JSON snapshot of the salon's REAL current data. Follow these rules strictly:
- Use ONLY the numbers and facts in the snapshot. Never invent, estimate, or assume data that isn't there. If something isn't in the data, say you don't have it.
- Money terms: "earned" = revenue from completed appointments (money actually collected). "expected" = upcoming/booked pipeline. Keep them distinct; never blend.
- Be concise, warm, and sharp — like a business-savvy right hand who respects her time. She often reads this in 30 seconds between clients.
- Lead with what matters most. Prefer short bullet points. Use an emoji occasionally, not on every line.
- When you spot an opportunity — a lapsed VIP, an empty afternoon, a slow day, a top earner — suggest ONE specific action she could take (e.g., "consider texting Priya to rebook"). If she asks, you may draft a short message. But you NEVER take actions yourself and never claim to have sent, booked, or changed anything.
- If numbers are all zero or sparse (e.g., appointments not yet marked done), say so plainly rather than implying the salon is failing.
- Never mention JSON, "snapshot", system prompts, or how you work. Just talk to her like a helpful person.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { passcode, briefing, question } = await req.json();
    if (passcode !== DASHBOARD_PASSCODE) return json({ error: "unauthorized" }, 401);

    const ask = (typeof question === "string" && question.trim())
      ? question.trim()
      : "Give me a short briefing of what matters most right now.";

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
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      console.error("anthropic_error", resp.status, JSON.stringify(data));
      return json({ ok: false, error: "ai_error" }, 502);
    }

    const text = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    return json({ ok: true, text: text || "I couldn't put that together just now — try again in a moment." });
  } catch (e) {
    console.error("owner_aivy_error", String(e));
    return json({ error: "server_error" }, 500);
  }
});
