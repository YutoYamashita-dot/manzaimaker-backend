// api/credit/add.js
export const config = { runtime: "nodejs" };
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const { user_id, delta } = req.body || {};
    const add = Number(delta) || 0;
    if (!user_id || add <= 0) return res.status(400).json({ error: "bad params" });

    const { data, error } = await supabase
      .from("user_usage")
      .select("paid_credits")
      .eq("user_id", user_id)
      .maybeSingle();
    if (error) throw error;

    const cur = data?.paid_credits ?? 0;
    const next = cur + add;

    const { error: upErr } = await supabase
      .from("user_usage")
      .upsert({ user_id, paid_credits: next, updated_at: new Date().toISOString() });

    if (upErr) throw upErr;

    return res.status(200).json({ ok: true, paid_credits: next });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server Error" });
  }
}
