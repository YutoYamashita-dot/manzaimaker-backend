// api/credit/get.js
// Supabaseに保存されているユーザのクレジット残高を返すAPI
// 必須: 環境変数 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// POST body: { user_id: "xxxx" }
// レスポンス: { paid_credits: number }

export const config = { runtime: "nodejs" };

import { createClient } from "@supabase/supabase-js";

// Supabase接続
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { user_id } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    // データベースから該当ユーザの paid_credits を取得
    const { data, error } = await supabase
      .from("user_usage")
      .select("paid_credits")
      .eq("user_id", user_id)
      .maybeSingle();

    if (error) {
      console.error("[Supabase error]", error.message);
      return res.status(500).json({ error: "Supabase query failed" });
    }

    // 該当ユーザが存在しない場合は0として返す
    const paid = data?.paid_credits ?? 0;

    return res.status(200).json({ paid_credits: paid });
  } catch (err) {
    console.error("[API error]", err.message);
    return res.status(500).json({ error: "Server error" });
  }
}