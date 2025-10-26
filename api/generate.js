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

/* =========================
  既存互換ユーティリティ（そのまま維持）
========================= */
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
      .upsert({ user_id, output_count: next, updated_at: new Date().toISOString() });
    if (upErr) throw upErr;
    return next;
  } catch (e) {
    console.warn("[supabase] incrementUsage failed:", e?.message || e);
    return null;
  }
}

/* === ★ 課金ユーティリティ（後払い消費：失敗時は絶対に減らさない） === */
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
    .upsert({ user_id, output_count, paid_credits, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/** 生成前：残高チェックのみ（消費しない） */
async function checkCredit(user_id) {
  if (!hasSupabase || !user_id) return { ok: true, row: null };
  const row = await getUsageRow(user_id);
  const used = row.output_count ?? 0;
  const paid = row.paid_credits ?? 0;
  return { ok: used < FREE_QUOTA || paid > 0, row };
}

/** 生成成功後：ここで初めて消費（無料→有料の順） */
async function consumeAfterSuccess(user_id) {
  if (!hasSupabase || !user_id) return { consumed: null };
  const row = await getUsageRow(user_id);
  const used = row.output_count ?? 0;
  const paid = row.paid_credits ?? 0;

  if (used < FREE_QUOTA) {
    await setUsageRow(user_id, { output_count: used + 1, paid_credits: paid });
    return { consumed: "free" };
  }
  if (paid > 0) {
    await setUsageRow(user_id, { output_count: used + 1, paid_credits: paid - 1 });
    return { consumed: "paid" };
  }
  return { consumed: null };
}

/* =========================
  1. 技法 定義テーブル（削除せず維持）
========================= */
const BOKE_DEFS = {
  IIMACHIGAI:
    "言い間違い／聞き間違い：音韻のズレで意外性を生むボケ（例：「カニ食べ行こう」→「紙食べ行こう？」）。",
  HIYU: "比喩ボケ：比喩で誇張してのボケ",
  GYAKUSETSU: "逆説ボケ：一見正論に聞こえるが論理が破綻しているボケ。",
  GIJI_RONRI:
    "擬似論理ボケ：論理風だが中身がズレているボケ（例：「犬は四足、だから社長」）。",
  TSUKKOMI_BOKE: "ツッコミボケ：ツッコミの発言が次のボケの伏線になるボケ。",
  RENSA: "ボケの連鎖：ボケが次のボケを誘発するように連続させ、加速感を生むボケ。",
  KOTOBA_ASOBI: "言葉遊び：ダジャレ・韻などで言語的にふざける。",
};

const TSUKKOMI_DEFS = {
  ODOROKI_GIMON:
    "驚き・疑問ツッコミ：観客の代弁として即時の驚き・疑問でのツッコミ。",
  AKIRE_REISEI:
    "呆れ・冷静ツッコミ：感情を抑えた冷静な態度でのツッコミ。",
  OKORI: "怒りツッコミ：怒ったような言い方でのツッコミ。",
  KYOKAN: "共感ツッコミ：相手の感情に一度共感してから、ツッコミをする。",
  META: "メタツッコミ：漫才の形式・構造そのものを指摘するツッコミ。",
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
  2) 旧仕様：ランダム技法（維持）
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
function enforceCharLimit(text, minLen, maxLen, allowOverflow = false) {
  if (!text) return "";
  let t = text.trim().replace(/```[\s\S]*?```/g, "").replace(/^#{1,6}\s.*$/gm, "").trim();

  if (!allowOverflow && t.length > maxLen) {
    const softCut = t.lastIndexOf("\n", maxLen);
    const softPuncs = ["。", "！", "？", "…", "♪"];
    const softPuncCut = Math.max(...softPuncs.map((p) => t.lastIndexOf(p, maxLen)));
    let cutPos = Math.max(softPuncCut, softCut);
    if (cutPos < maxLen * 0.9) cutPos = maxLen;
    t = t.slice(0, cutPos).trim();
    if (!/[。！？…♪]$/.test(t)) t += "。";
  }
  if (t.length < minLen && !/[。！？…♪]$/.test(t)) t += "。";
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

/* 行頭の「名前：/名前:」を「名前: 」に正規化 */
function normalizeSpeakerColons(s) {
  return s.replace(/(^|\n)([^\n:：]+)[：:]\s*/g, (_m, head, name) => `${head}${name}: `);
}

/* 台詞間を1行空ける（重複空行は圧縮） */
function ensureBlankLineBetweenTurns(text) {
  const lines = text.split("\n");
  const compressed = [];
  for (const ln of lines) {
    if (ln.trim() === "" && compressed.length && compressed[compressed.length - 1].trim() === "") continue;
    compressed.push(ln);
  }
  const out = [];
  for (let i = 0; i < compressed.length; i++) {
    const cur = compressed[i];
    out.push(cur);
    const isTurn = /^[^:\n：]+:\s/.test(cur.trim());
    const next = compressed[i + 1];
    const nextIsTurn = next != null && /^[^:\n：]+:\s/.test(next?.trim() || "");
    if (isTurn && nextIsTurn) {
      if (cur.trim() !== "" && (next || "").trim() !== "") out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
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
  4) ガイドライン生成（維持）
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
  5) プロンプト生成（±10%バンド厳守）
========================= */
function buildPrompt({ theme, genre, characters, length, selected }) {
  const safeTheme = theme?.toString().trim() || "身近な題材";
  const safeGenre = genre?.toString().trim() || "一般";
  const names = (characters?.toString().trim() || "A,B")
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  const targetLen = Math.min(Number(length) || 350, 2000);
  const minLen = Math.max(100, Math.floor(targetLen * 0.9));
  const maxLen = Math.ceil(targetLen * 1.1);
  const minLines = Math.max(12, Math.ceil(minLen / 35));

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
    guideline = "【採用する技法（クライアント未指定のため自動選択）】\n" + usedTechs.map((t) => `- ${t}`).join("\n");
  }

  const tsukkomiName = names[1] || "B";

  const prompt = [
    "あなたは実力派の漫才師コンビです。「選択された技法」を必ず使い、日本語の漫才台本を作成してください。",
    "",
    `■題材: ${safeTheme}`,
    `■ジャンル: ${safeGenre}`,
    `■登場人物: ${names.join("、")}`,
    `■目標文字数: ${minLen}〜${maxLen}文字（必ずこの範囲内に収める）`,
    "",
    "■必須の構成",
    "- 1) フリ（導入）：ボケやオチを成立させるための「前提」「状況設定」「観客との共通認識づくり」を設定する。",
    "- 2) 伏線回収：フリ（導入）の段階で提示された情報・言葉・構図を、後半で再登場させて「意外な形で再接続」させる。",
    "- 3) 最後は明確な“オチ”：全てのズレ・やり取りを収束させる表現、言葉を使う。",
    "",
    // ★ 強化：「選択された技法」を“必ず”使う（未使用は不可）
    "■必ず使用する技法（名称を本文に書かない）",
    "- 下記の各技法は **すべて** 本文中で最低1回以上、観客に伝わる具体的な台詞や展開として **必ず** 用いること（未使用は不可）。",
    "- 出力前に **自己チェック** を行い、未使用の技法がある場合は **本文を追記** して満たしてから出力を終えること。",
    "- 技法名や“この技法を使う”といったメタ表現は本文に **絶対に書かない**。",
    guideline || "",
    "",
    "■分量・形式の厳守",
    `- 会話の行数は 少なくとも ${minLines} 行以上（1台詞あたり 25〜40 文字目安）。`,
    "- 各台詞は「名前: セリフ」の形式（半角コロン＋半角スペース : を使う）。",
    "- 各台詞の間には必ず空行を1つ入れる（Aの行とBの行の間を1行空ける）。",
    "- 出力は本文のみ（解説・メタ記述や途中での打ち切りを禁止）。",
    `- 最後は必ず ${tsukkomiName}: もういいよ の一行で締める（この行は文字数に含める）。`,
    "- 「比喩」「皮肉」「風刺」と直接本文に書かない。",
    "- 「緊張感のある状態」とそれが「緩和する状態」を必ず作る。",
    "- 「選択された技法」をしっかり使う。",
    "■見出し・書式",
    "- 最初の1行に【タイトル】を入れ、その直後に本文（漫才）を続ける",
    "- タイトルと本文の間には必ず空行を1つ入れる",
　　"■その他",
    "- 人間にとって「意外性」があるが「納得感」のある表現を使う。",
    "- 登場人物の個性を反映する。",
   

  ].join("\n");

  return { prompt, techniquesForMeta, structureMeta, maxLen, minLen, tsukkomiName, targetLen };
}

/* ===== 指定文字数に30字以上足りない場合に本文を追記する ===== */
async function generateContinuation({ client, model, baseBody, remainingChars, tsukkomiName }) {
  let seed = baseBody.replace(new RegExp(`${tsukkomiName}: もういいよ\\s*$`), "").trim();

  const contPrompt = [
    "以下は途中まで書かれた漫才の本文です。これを“そのまま続けてください”。",
    "・タイトルは出さない",
    "・これまでの台詞やネタの反復はしない",
    `・少なくとも ${remainingChars} 文字以上、自然に展開し、最後は ${tsukkomiName}: もういいよ で締める`,
    "・各行は「名前: セリフ」の形式（半角コロン＋スペース）",
    "・台詞同士の間には必ず空行を1つ挟む",
    "",
    "【これまでの本文】",
    seed,
  ].join("\n");

  const messages = [
    { role: "system", content: "あなたは実力派の漫才師コンビです。本文の“続き”だけを出力してください。" },
    { role: "user", content: contPrompt },
  ];

  const approxTok = Math.min(8192, Math.ceil(Math.max(remainingChars * 2, 400) * 3)); // ★余裕UP
  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.1,
    max_output_tokens: approxTok,
    max_tokens: approxTok,
  });

  let cont = resp?.choices?.[0]?.message?.content?.trim() || "";
  cont = normalizeSpeakerColons(cont);
  cont = ensureBlankLineBetweenTurns(cont);
  cont = ensureTsukkomiOutro(cont, tsukkomiName);
  return (seed + "\n" + cont).trim();

}

/* =========================
  6) Grok (xAI) 呼び出し
========================= */
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

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
  7) HTTP ハンドラ（後払い消費＋安定出力のための緩和）
========================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { theme, genre, characters, length, boke, tsukkomi, general, user_id } = req.body || {};

    // 生成前：残高チェックのみ（消費なし）
    const gate = await checkCredit(user_id);
    if (!gate.ok) {
      const row = gate.row || { output_count: 0, paid_credits: 0 };
      return res.status(403).json({
        error: `使用上限（${FREE_QUOTA}回）に達しており、クレジットが不足しています。`,
        usage_count: row.output_count,
        paid_credits: row.paid_credits,
      });
    }

    const { prompt, techniquesForMeta, structureMeta, maxLen, minLen, tsukkomiName, targetLen } = buildPrompt({
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

    // モデル呼び出し（xAIは max_output_tokens を参照）★余裕UP
    const approxMaxTok = Math.min(8192, Math.ceil(Math.max(maxLen * 2, 3500) * 3));
    const messages = [
      { role: "system", content: "あなたは実力派の漫才師コンビです。舞台で即使える台本だけを出力してください。解説・メタ記述は禁止。" },
      { role: "user", content: prompt },
    ];
    const payload = {
      model: process.env.XAI_MODEL || "grok-4-fast-reasoning",
      messages,
      temperature: 0.8,
      max_output_tokens: approxMaxTok,
      max_tokens: approxMaxTok,
    };

    let completion;
    try {
      completion = await client.chat.completions.create(payload);
    } catch (err) {
      const e = normalizeError(err);
      console.error("[xAI error]", e);
      // 後払い方式：ここでは消費しない
      return res.status(e.status || 500).json({ error: "xAI request failed", detail: e });
    }

    // 整形（★順序を安定化：normalize → 空行 → 落ち付与）
    let raw = completion?.choices?.[0]?.message?.content?.trim() || "";
    let { title, body } = splitTitleAndBody(raw);

    body = enforceCharLimit(body, minLen, Number.MAX_SAFE_INTEGER, true); // 上限で切らない
    body = normalizeSpeakerColons(body);
    body = ensureBlankLineBetweenTurns(body);
    body = ensureTsukkomiOutro(body, tsukkomiName);

    // 指定文字数との差を補う
    const deficit = targetLen - body.length;
    if (deficit >= 30) {
      try {
        body = await generateContinuation({
          client,
          model: process.env.XAI_MODEL || "grok-4-fast-reasoning",
          baseBody: body,
          remainingChars: deficit,
          tsukkomiName,
        });
        // 追記後も同じ順序で仕上げ
        body = normalizeSpeakerColons(body);
        body = ensureBlankLineBetweenTurns(body);
        body = ensureTsukkomiOutro(body, tsukkomiName);
      } catch (e) {
        console.warn("[continuation] failed:", e?.message || e);
      }
    }

    // ★ 最終レンジ調整：上下10%の範囲に収める（allowOverflow=false）
    body = enforceCharLimit(body, minLen, maxLen, false);

    // 成功判定：★本文非空のみ（語尾揺れで落とさない）
    const success = typeof body === "string" && body.trim().length > 0;
    if (!success) {
      // 失敗：消費しない
      return res.status(500).json({ error: "Empty output" });
    }

    // 成功：ここで初めて消費
    await consumeAfterSuccess(user_id);

    // 残量取得
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
        target_length: targetLen,
        min_length: minLen,
        max_length: maxLen,
        actual_length: body.length,
      },
    });
  } catch (err) {
    const e = normalizeError(err);
    console.error("[handler error]", e);
    // 失敗：もちろん消費しない
    return res.status(500).json({ error: "Server Error", detail: e });
  }
}
