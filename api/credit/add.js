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
    let add = 0;

    // フロント互換:
    // - 数値 or 数値文字列 → そのまま加算
    // - "credit_1" / "credit_10" / "credit_100" → それぞれ 1 / 10 / 100 を加算
    if (typeof delta === "number") {
      add = delta;
    } else if (typeof delta === "string") {
      const n = Number(delta);
      if (!Number.isNaN(n) && n > 0) {
        add = n;
      } else {
        if (delta === "credit_1") add = 1;
        else if (delta === "credit_10") add = 10;
        else if (delta === "credit_100") add = 100;
      }
    }

    add = Number(add) || 0;

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
