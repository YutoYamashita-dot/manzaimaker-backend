// api/generate.js
// Vercel Node.js (ESM)。本文と「タイトル」を日本語で返す（台本のみ）
// 必須: XAI_API_KEY
// 任意: XAI_MODEL（未設定なら grok-4）
// 追加: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（ある場合、user_id の回数/クレジットを保存）

export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* =========================
   Supabase Client
   ========================= */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const hasSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
const supabase = hasSupabase ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// 既存互換：使用回数を +delta（無ければ行を作成）
async function incrementUsage(user_id, delta = 1) {
  if (!hasSupabase || !user_id) return null;
  try {
    const { data, error } = await supabase
      .from("user_usage")
      .select("output_count")
      .eq("user_id", user_id)
      .maybeSingle();
    if (error) throw error;

    const current = data?.output_count ?? 0;
    const next = current + Math.max(delta, 0);

    const { error: upErr } = await supabase
      .from("user_usage")
      .upsert({
        user_id,
        output_count: next,
        updated_at: new Date().toISOString(),
      });
    if (upErr) throw upErr;
    return next;
  } catch (e) {
    console.warn("[supabase] incrementUsage failed:", e?.message || e);
    return null;
  }
}

/* === ★ 追加：無料枠と有料クレジットの消費ユーティリティ（失敗時ロールバック対応） === */
const FREE_QUOTA = 20;

async function getUsageRow(user_id) {
  if (!hasSupabase || !user_id) return { output_count: 0, paid_credits: 0 };
  const { data, error } = await supabase
    .from("user_usage")
    .select("output_count, paid_credits")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || { output_count: 0, paid_credits: 0 };
}

async function setUsageRow(user_id, { output_count, paid_credits }) {
  if (!hasSupabase || !user_id) return;
  const { error } = await supabase
    .from("user_usage")
    .upsert({
      user_id,
      output_count,
      paid_credits,
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
}

/** 生成前：残高チェックのみ（消費はしない）。成功時 {ok:true}、不足時 {ok:false,row} を返す */
async function checkCredit(user_id) {
  if (!hasSupabase || !user_id) return { ok: true, row: null }; // 課金未使用構成なら常にOK
  const row = await getUsageRow(user_id);
  const used = row.output_count ?? 0;
  const paid = row.paid_credits ?? 0;
  if (used < FREE_QUOTA || paid > 0) return { ok: true, row };
  return { ok: false, row };
}

/** 生成成功後：実消費（前払いではなく“後払い”で消費）。返却値は {consumed: "free"|"paid"|null} */
async function consumeAfterSuccess(user_id) {
  if (!hasSupabase || !user_id) return { consumed: null };
  const row = await getUsageRow(user_id);
  const used = row.output_count ?? 0;
  const paid = row.paid_credits ?? 0;
  // 無料枠が残っていれば無料枠を消費、無ければ有料クレジットを消費
  if (used < FREE_QUOTA) {
    await setUsageRow(user_id, { output_count: used + 1, paid_credits: paid });
    return { consumed: "free" };
  }
  if (paid > 0) {
    await setUsageRow(user_id, { output_count: used + 1, paid_credits: paid - 1 });
    return { consumed: "paid" };
  }
  // ここに来るのは理論上不足（直前チェックと競合したなど）
  return { consumed: null };
}

/* =========================
   1) 技法 定義テーブル
   ========================= */
const BOKE_DEFS = {
  IIMACHIGAI:
    "言い間違い／聞き間違い：音韻のズレで意外性を生む（例：「カニ食べ行こう」→「紙食べ行こう？」）。",
  HIYU: "比喩ボケ：日常を比喩で誇張",
  GYAKUSETSU: "逆説ボケ：一見正論に聞こえるが論理が破綻している。",
  GIJI_RONRI:
    "擬似論理ボケ：論理風だが中身がズレている（例：「犬は四足、だから社長」）。",
  TSUKKOMI_BOKE: "ツッコミボケ：ツッコミの発言が次のボケの伏線になる構造。",
  RENSA: "ボケの連鎖：ボケが次のボケを誘発するように連続させ、加速感を生む。",
  KOTOBA_ASOBI: "言葉遊び：ダジャレ・韻・多義語などの言語的転倒。",
};

const TSUKKOMI_DEFS = {
  ODOROKI_GIMON:
    "驚き・疑問ツッコミ：観客の代弁として即時の驚き・疑問でズレを顕在化。",
  AKIRE_REISEI:
    "呆れ・冷静ツッコミ：感情を抑えた冷静な態度で境界線を描く。",
  OKORI: "怒りツッコミ：強めの感情でズレを是正し笑いの対象を明確化。",
  KYOKAN: "共感ツッコミ：観客の立場・感情を代弁して共感の中で笑いを起こす。",
  META: "メタツッコミ：漫才の形式・構造そのものを自覚的に指摘する視点。",
};

const GENERAL_DEFS = {
  SANDAN_OCHI: "三段オチ：1・2をフリ、3で意外なオチ。",
  GYAKUHARI: "逆張り構成：期待・常識を外して予想を逆手に取る。",
  TENKAI_HAKAI: "展開破壊：築いた流れを意図的に壊し異質な要素を挿入。",
  KANCHIGAI_TEISEI: "勘違い→訂正：ボケの勘違いをツッコミが訂正する構成。",
  SURECHIGAI: "すれ違い：互いの前提が噛み合わずズレ続けて笑いを生む。",
  TACHIBA_GYAKUTEN: "立場逆転：途中または終盤で役割・地位がひっくり返る。",
};

/* =========================
   2) 旧仕様：ランダム技法
   ========================= */
const MUST_HAVE_TECH = "比喩ツッコミ";
function pickTechniquesWithMetaphor() {
  const pool = ["風刺", "皮肉", "意外性と納得感", "勘違い→訂正", "言い間違い→すれ違い", "立場逆転", "具体例の誇張"];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const extraCount = Math.floor(Math.random() * 3) + 1;
  return [MUST_HAVE_TECH, ...shuffled.slice(0, extraCount)];
}

/* =========================
   3) 文字数の最終調整
   ========================= */
function enforceCharLimit(text, maxLen) {
  if (!text) return "";
  let t = text.trim().replace(/```[\s\S]*?```/g, "").replace(/^#{1,6}\s.*$/gm, "").trim();

  if (t.length > maxLen) {
    const softCut = t.lastIndexOf("\n", maxLen);
    const softPuncs = ["。", "！", "？", "…", "♪"];
    const softPuncCut = Math.max(...softPuncs.map((p) => t.lastIndexOf(p, maxLen)));
    let cutPos = Math.max(softPuncCut, softCut);
    if (cutPos < maxLen * 0.7) cutPos = maxLen;
    t = t.slice(0, cutPos).trim();
    if (!/[。！？…♪]$/.test(t)) t += "。";
  }
  if (!/[。！？…♪]$/.test(t)) t += "。";
  return t;
}

/* =========================
   3.5) 最終行の強制付与
   ========================= */
function ensureTsukkomiOutro(text, tsukkomiName = "B") {
  const outro = `${tsukkomiName}: もういいよ`;
  if (!text) return outro;
  if (/もういいよ\s*$/.test(text)) return text;
  return text.replace(/\s*$/, "") + "\n" + outro;
}

/* （任意）行頭の「名前：/名前:」を「名前: 」に正規化 */
function normalizeSpeakerColons(s) {
  return s.replace(/(^|\n)([^\n:：]+)[：:]\s*/g, (_m, head, name) => `${head}${name}: `);
}

/* =========================
   3.6) タイトル/本文の分割
   ========================= */
function splitTitleAndBody(s) {
  if (!s) return { title: "", body: "" };
  const parts = s.split(/\r?\n\r?\n/, 2);
  const title = (parts[0] || "").trim().replace(/^【|】$/g, "");
  const body = (parts[1] ?? s).trim();
  return { title, body };
}

/* =========================
   4) ガイドライン生成
   ========================= */
function buildGuidelineFromSelections({ boke = [], tsukkomi = [], general = [] }) {
  const bokeLines = boke.filter((k) => BOKE_DEFS[k]).map((k) => `- ${BOKE_DEFS[k]}`);
  const tsukkomiLines = tsukkomi.filter((k) => TSUKKOMI_DEFS[k]).map((k) => `- ${TSUKKOMI_DEFS[k]}`);
  const generalLines = general.filter((k) => GENERAL_DEFS[k]).map((k) => `- ${GENERAL_DEFS[k]}`);
  const parts = [];
  if (bokeLines.length) parts.push("【ボケ技法】", ...bokeLines);
  if (tsukkomiLines.length) parts.push("【ツッコミ技法】", ...tsukkomiLines);
  if (generalLines.length) parts.push("【全般の構成技法】", ...generalLines);
  return parts.join("\n");
}

function labelizeSelected({ boke = [], tsukkomi = [], general = [] }) {
  const toLabel = (ids, table) => ids.filter((k) => table[k]).map((k) => table[k].split("：")[0]);
  return {
    boke: toLabel(boke, BOKE_DEFS),
    tsukkomi: toLabel(tsukkomi, TSUKKOMI_DEFS),
    general: toLabel(general, GENERAL_DEFS),
  };
}

/* =========================
   5) プロンプト生成
   ========================= */
function buildPrompt({ theme, genre, characters, length, selected }) {
  const safeTheme = theme && String(theme).trim() ? String(theme).trim() : "身近な題材";
  const safeGenre = genre && String(genre).trim() ? String(genre).trim() : "一般";
  const names = (characters && String(characters).trim() ? String(characters).trim() : "A,B")
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  const targetLen = Math.min(Number(length) || 350, 2000);
  const minLen = Math.max(100, Math.floor(targetLen * 0.9));
  const maxLen = targetLen;

  const hasNewSelection =
    (selected?.boke?.length || 0) + (selected?.tsukkomi?.length || 0) + (selected?.general?.length || 0) > 0;

  let techniquesForMeta = [];
  let guideline = "";
  let structureMeta = ["フリ", "伏線回収", "最後のオチ"];

  if (hasNewSelection) {
    guideline = buildGuidelineFromSelections(selected);
    const labels = labelizeSelected(selected);
    techniquesForMeta = [...labels.boke, ...labels.tsukkomi];
    structureMeta = [...structureMeta, ...labels.general];
  } else {
    const usedTechs = pickTechniquesWithMetaphor();
    techniquesForMeta = usedTechs;
    guideline =
      "【採用する技法（クライアント未指定のため自動選択）】\n" + usedTechs.map((t) => `- ${t}`).join("\n");
  }

  const tsukkomiName = names[1] || "B";

  const prompt = [
    "あなたは実力派の漫才師コンビです。日本語の漫才台本を作成してください。",
    "",
    `■題材: ${safeTheme}`,
    `■ジャンル: ${safeGenre}`,
    `■登場人物: ${names.join("、")}`,
    `■目標文字数: ${minLen}〜${maxLen}文字`,
    "",
    "■必須の構成",
    "- 1) フリ（導入）",
    "- 2) 伏線回収",
    "- 3) 最後は明確な“オチ”",
    "",
    "■選択された技法（技法の名称は本文に出さないこと）",
    guideline || "（特に指定なし）",
    "",
    "■文体・出力ルール",
    "- 最後の1行は必ずツッコミ役（2人目の登場人物）による「もういいよ」で終える",
    "- 最初の1行に【タイトル】を入れ、その直後に本文（会話）を続ける",
    "- タイトルと本文の間には必ず空行を1つ入れる",
    "- 会話は 名前：台詞 形式で、1台詞ごとに改行",
    "- 解説・注釈・見出しは書かない。本文のみを出力する",
    "- 人間にとって「意外性」のある表現を使う。",
  ].join("\n");

  return { prompt, techniquesForMeta, structureMeta, maxLen, tsukkomiName };
}

/* =========================
   6) Grok (xAI) 呼び出し
   ========================= */
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});
const MODEL = process.env.XAI_MODEL || "grok-4";

/* =========================
   失敗理由の整形
   ========================= */
function normalizeError(err) {
  return {
    name: err?.name,
    message: err?.message,
    status: err?.status ?? err?.response?.status,
    data: err?.response?.data ?? err?.error,
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
  };
}

/* =========================
   7) HTTP ハンドラ（失敗時にクレジットが減らないよう“後払い消費”）
   ========================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { theme, genre, characters, length, boke, tsukkomi, general, user_id } = req.body || {};

    // 生成前：残高チェックのみ（消費はしない）
    const gate = await checkCredit(user_id);
    if (!gate.ok) {
      const row = gate.row || { output_count: 0, paid_credits: 0 };
      return res.status(403).json({
        error: `使用上限（${FREE_QUOTA}回）に達しており、クレジットが不足しています。`,
        usage_count: row.output_count,
        paid_credits: row.paid_credits,
      });
    }

    const { prompt, techniquesForMeta, structureMeta, maxLen, tsukkomiName } = buildPrompt({
      theme,
      genre,
      characters,
      length,
      selected: {
        boke: Array.isArray(boke) ? boke : [],
        tsukkomi: Array.isArray(tsukkomi) ? tsukkomi : [],
        general: Array.isArray(general) ? general : [],
      },
    });

    const messages = [
      {
        role: "system",
        content:
          "あなたは実力派の漫才師コンビです。舞台で即使える台本だけを出力してください。解説・メタ記述は禁止。",
      },
      { role: "user", content: prompt },
    ];

    const payloadBase = { messages, temperature: 0.8, max_tokens: 8000 };

    let completion;
    try {
      completion = await client.chat.completions.create({ ...payloadBase, model: MODEL });
    } catch (err) {
      const e = normalizeError(err);
      console.error("[xAI error]", e);
      // ★ ここではまだ消費していないのでロールバック不要（後払い方式）
      return res.status(e.status || 500).json({ error: "xAI request failed", detail: e });
    }

    // 出力を整形
    let raw = completion?.choices?.[0]?.message?.content?.trim() || "";
    let { title, body } = splitTitleAndBody(raw);
    const outroLine = `${tsukkomiName}: もういいよ`;
    const reserve = Math.max(8, outroLine.length + 1);
    const safeMax = Math.max(50, (Number(maxLen) || 350) - reserve);
    body = enforceCharLimit(body, safeMax);
    body = ensureTsukkomiOutro(body, tsukkomiName);
    body = normalizeSpeakerColons(body);

    // 生成成功とみなせる本文か軽くチェック
    const success = body && body.length > 0;
    if (!success) {
      // ★ 失敗扱い：後払い方式なので消費なしのままエラー返却
      return res.status(500).json({ error: "Empty output" });
    }

    // ★ 生成成功 → ここで初めて“実消費”（無料枠 or 有料クレジット）
    await consumeAfterSuccess(user_id);

    // 返却用：最新の残量取得
    let metaUsage = null;
    let metaCredits = null;
    if (hasSupabase && user_id) {
      try {
        const row = await getUsageRow(user_id);
        metaUsage = row.output_count ?? null;
        metaCredits = row.paid_credits ?? null;
      } catch (e) {
        console.warn("[supabase] fetch after consume failed:", e?.message || e);
      }
    }

    return res.status(200).json({
      title: title || "（タイトル未設定）",
      text: body || "（ネタの生成に失敗しました）",
      meta: {
        structure: structureMeta,
        techniques: techniquesForMeta,
        usage_count: metaUsage,
        paid_credits: metaCredits,
      },
    });
  } catch (err) {
    const e = normalizeError(err);
    console.error("[handler error]", e);
    return res.status(500).json({ error: "Server Error", detail: e });
  }
}
