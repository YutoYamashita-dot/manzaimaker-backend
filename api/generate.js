// api/generate.js
// Vercel Node.js (ESM)。本文と「タイトル」を日本語で返す（台本のみ）
// 必須: XAI_API_KEY
// 任意: XAI_MODEL（未設定なら grok-4）
// 追加: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（ある場合、user_id の回数/クレジットを保存）

export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { detectLang, LANG_NAME, SPEAKER_TAGS } from "../utils/lang.js";

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
const FREE_QUOTA = 500;

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
   技法 定義テーブル（削除せず維持）
   ========================= */
const BOKE_DEFS = {
  IIMACHIGAI:
    "Mispronunciation/Mishearing: A comedic effect created by unexpected phonetic shifts.",
  HIYU: "Metaphor: A joke that exaggerates through metaphor.",
  GYAKUSETSU: "Paradox: A joke that sounds reasonable at first but falls apart logically.",
  GIJI_RONRI:
    "Pseudo-logical joke: A joke that appears logical but is fundamentally flawed.",
  TSUKKOMI_BOKE: "Tsukkomi-style punchline: A punchline where the tsukkomi's remark sets up the next joke.",
  RENSA: "Chain of jokes: A series of jokes that trigger subsequent jokes, creating a sense of acceleration.",
  KOTOBA_ASOBI: "Wordplay: Playing around with language through puns, rhymes, etc.",
};

const TSUKKOMI_DEFS = {
  ODOROKI_GIMON:
    "Surprise / Question Tsukkomi： A retort that instantly voices surprise or doubt on behalf of the audience.Often delivered with wide-eyed astonishment or an exclamation like “What are you talking about?!” — this style bridges the performer and the audience by reacting naturally to the boke’s (funny man’s) absurd statement.",
  AKIRE_REISEI: "Exasperated / Calm Tsukkomi：A reaction that suppresses emotion and stays cool, almost as if giving up on the boke’s nonsense.The humor comes from understatement and composure — the calmness itself contrasts sharply with the chaos, making it funnier.",
  OKORI: "Angry Tsukkomi：A retort delivered with mock anger or heightened emotion.The tsukkomi acts furious — shouting or scolding — but it’s performed in a controlled, comedic way that signals playfulness rather than real aggression.",
  KYOKAN: "Empathetic Tsukkomi：The tsukkomi first empathizes with the boke’s emotion or idea — “Yeah, I get that…” — and then humorously corrects or challenges it.This creates a sense of warmth and human connection before the punchline.",
  META: "Meta Tsukkomi： A self-aware retort that breaks the fourth wall by commenting on the manzai performance itself — its format, timing, or comedic clichés.It humoously points out the structure of the act, like saying “That’s not how manzai is supposed to go!” or “You’re skipping the setup!”",
};

const GENERAL_DEFS = {
  SANDAN_OCHI: "Three-Step Punchline：A structure where the first two lines set a pattern, and the third delivers an unexpected twist.The humor arises from rhythmic repetition and the final subversion — setup, setup, surprise.Comparable to: the “rule of three” in Western comedy, but often with tighter rhythm and visual payoff.",
  GYAKUHARI: "Reversal Logic：A technique that deliberately goes against audience expectations or common sense.The comedian takes a predictable setup and turns it upside down to reveal absurd or ironic truth.Comparable to: “contrarian humor” or “bait-and-switch jokes.”",
  TENKAI_HAKAI: "Narrative Disruption：Intentionally breaking a story’s flow or inserting a completely unrelated element to create absurdity.The fun comes from destroying the narrative momentum just as it feels stable.Comparable to: “breaking narrative structure” or “anti-comedy” moments.",
  KANCHIGAI_TEISEI: "Misunderstanding and Correction：A classic boke–tsukkomi pattern where the boke (funny man) misunderstands something, and the tsukkomi (straight man) sharply corrects it.The rhythm of “mistake → correction” drives the comedic timing.Comparable to: “misinterpretation gags” or “semantic confusion” jokes.",
  SURECHIGAI: "Miscommunication Comedy：A situation where both characters keep talking past each other because their assumptions differ.The humor builds from their continued failure to align perspectives.Comparable to: “cross-talk” or “comedic misunderstanding dialogue.”",
  TACHIBA_GYAKUTEN: "Role Reversal：Midway or at the end, the power balance or social position between characters flips.",
};

/* =========================
   2) 旧仕様：ランダム技法（維持）

   ========================= */
const MUST_HAVE_TECH = "Metaphor";
function pickTechniquesWithMetaphor() {
  const pool = ["Satire", "Irony", "Surprise and Conviction", "Misunderstanding and Correction", "Miscommunication comedy", "Role Reversal comedy", "Exaggeration of Specific Examples"];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const extraCount = Math.floor(Math.random() * 3) + 1;
  return [MUST_HAVE_TECH, ...shuffled.slice(0, extraCount)];
}

/* =========================
   3) 文字数の最終調整
   ========================= */
function enforceCharLimit(text, minLen, maxLen, allowOverflow = false) {
  if (!text) return "";
  // 本文から不要なコードブロックや見出しを軽く除去（構文を修正）
  let t = text
    .trim()
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .trim();

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
  const outro = `${tsukkomiName}: That's allright!`;
  if (!text) return outro;
  if (/That's allright!\s*$/.test(text)) return text;
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
// ★ 言語対応：outLangName を追加（その他ロジックは変更なし）
function buildPrompt({ theme, genre, characters, length, selected, outLangName = "English" }) {
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
  let structureMeta = ["Setup / Introduction", "Callback / Foreshadowing Payoff", "Clear Final Punch"];

  if (hasNewSelection) {
    guideline = buildGuidelineFromSelections(selected);
    const labels = labelizeSelected(selected);
    techniquesForMeta = [...labels.boke, ...labels.tsukkomi];
    structureMeta = [...structureMeta, ...labels.general];
  } else {
    const usedTechs = pickTechniquesWithMetaphor();
    techniquesForMeta = usedTechs;
    guideline = "【Techniques to be adopted】\n" + usedTechs.map((t) => `- ${t}`).join("\n");
  }

  const tsukkomiName = names[1] || "B";

  const prompt = [
    // ★ ここだけ言語指定を追記：出力は outLangName で
    `### STRICT LANGUAGE INSTRUCTION`,
    `All output (title, lines, and punctuation) MUST BE 100% IN ${outLangName.toUpperCase()}.`,
    `Do NOT use, mix, or include ANY OTHER LANGUAGE (no Japanese, no Chinese, no transliterations, no mixed phrases).`,
    `If any non-${outLangName} characters appear, IMMEDIATELY REWRITE them entirely in ${outLangName} before responding.`,
    `### CONDITIONS`,
    `■Theme: ${safeTheme}`,
    `■Genre: ${safeGenre}`,
    `■Characters: ${names.join("、")}`,
    `■Target word count: ${minLen}〜${maxLen}Text (Fit within this area)`,
    "",
    "■Required configuration",
    "- 1) Setup / Introduction：The “setup” phase that establishes the premise, situation, and shared understanding between the performers and the audience. It prepares the ground for later jokes (boke) or punchlines (ochi) by defining the context, tone, and logic of the world. Comparable to: the “premise” or “framing” in Western sketch or stand-up comedy.",
    "- 2) Callback / Foreshadowing Payoff：A technique where information, phrases, or visual motifs introduced earlier (in the furi) reappear later in a surprising and meaningful way. The laughter comes from the audience’s recognition and the clever re-connection of elements that seemed trivial before. Comparable to: “callback jokes” or “Chekhov’s gun” used comedically.",
    "- 3) Clear Final Punch：The definitive punchline or closing expression that resolves all the comedic tension and misalignments built throughout the act. It serves as the narrative and emotional endpoint — signaling to the audience, “this is the laugh we’ve been building toward.” Comparable to: the “punchline” or “button” in Western comedy, but in owarai, it carries stronger structural and rhythmic significance.",
    "",
    // ★ 強化：「選択された技法」を“必ず”使う（未使用は不可）
    "■Required techniques (do not list technique names in the main text)",
    "- All of the following techniques must be used at least once in the main text as specific lines or developments that are conveyed to the audience (non-use is not allowed).",
    "- Before outputting, perform a self-check, and if there are any unused techniques, add to the main text to fulfill this requirement.",
    guideline || "",
    "",
    "■Strict adherence to quantity and format",
    `- Dialogue must contain at least ${minLines} lines (aim for 25-40 characters per line).`,
    "- Each line must follow the format ”Name: Line“ (using a half-width colon : followed by a half-width space).",
    "- Always insert one blank line between each line of dialogue (leave one blank line between A's line and B's line).",
    "- Output must be the main text only (no explanations, meta descriptions, or abrupt endings allowed).",
    `- Always end with the line ${tsukkomiName}: That's enough (include this line in the character count). `,
    "- Do not directly write ”metaphor,“ ”irony,“ or ‘satire’ in the main text.",
    "- Always create a ”tense state“ and a ”state where it is relieved.“",
    "- Use the ”selected technique“ thoroughly.",
    "■Headings and Formatting",
    "- Place the 【Title】 on the first line, followed immediately by the main text (comedy routine)",
    "- Always insert one blank line between the title and the main text",
    "■Other",
    "- Use expressions that are unexpected yet satisfying to humans.",
    "- Reflect the characters' personalities.",
    "- Use expressions that make the audience laugh heartily.",
    "- Sprinkle in irony and satire here and there.",
  ].join("\n");

  return { prompt, techniquesForMeta, structureMeta, maxLen, minLen, tsukkomiName, targetLen };
}

/* ===== 指定文字数に30字以上足りない場合に本文を追記する ===== */
async function generateContinuation({ client, model, baseBody, remainingChars, tsukkomiName }) {
   let seed = baseBody.replace(new RegExp(`${tsukkomiName}: That's allright!\\s*$`), "").trim();
  const contPrompt = [
    "The following is the text of a manzai routine written only partially. Please continue it as is.",
    "・Do not include the title",
    "・Do not repeat previous lines or material",
    `・Expand naturally for at least ${remainingChars} characters, ending with ${tsukkomiName}: That's allright!`,
    "・Each line follows the format ”Name: Line“ (half-width colon + space)",
    "・Always insert one blank line between lines of dialogue",
    "",
    "【Previous text】",
    seed,
  ].join("\n");

  const messages = [
    { role: "system", content: "You are a talented comedy duo. Please output only the “continuation” of the main text." },
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
        error: `You have reached your usage limit (${FREE_QUOTA} times) and are running low on credits.`,
        usage_count: row.output_count,
        paid_credits: row.paid_credits,
      });
    }

    // ★ 修正：アプリ指定言語を最優先（入力言語は無視）
    const appLangTag = (req.body?.app_lang || req.headers["x-app-lang"] || "").toString().trim();
    const fixedLangCode = appLangTag || "en";
    const outLangName = LANG_NAME[fixedLangCode] || "English";

    // ✅ ★ ここでログを出す
    console.log("[lang-check]", {
      app_lang: req.body?.app_lang,
      x_app_lang: req.headers["x-app-lang"],
      accept_language: req.headers["accept-language"],
    });

    // ★ 追加：日本語/中国語以外の入力は4000字までに制限（theme / genre / characters）
    const isJaOrZh = /^ja(\b|[-_])|^zh(\b|[-_])/i.test(fixedLangCode || "");
    const LIMIT = 4000;
    const cap = (s) => (typeof s === "string" ? s.slice(0, LIMIT) : s);

    const themeC = isJaOrZh ? theme : cap(theme);
    const genreC = isJaOrZh ? genre : cap(genre);
    const charactersC = isJaOrZh ? characters : cap(characters);

    const { prompt, techniquesForMeta, structureMeta, maxLen, minLen, tsukkomiName, targetLen } = buildPrompt({
      theme: themeC,
      genre: genreC,
      characters: charactersC,
      length,
      selected: {
        boke: Array.isArray(boke) ? boke : [],
        tsukkomi: Array.isArray(tsukkomi) ? tsukkomi : [],
        general: Array.isArray(general) ? general : [],
      },
      // ★ 出力言語名をプロンプトに注入
      outLangName,
    });

    // モデル呼び出し（xAIは max_output_tokens を参照）★余裕UP
    const approxMaxTok = Math.min(8192, Math.ceil(Math.max(maxLen * 2, 3500) * 3));
    const messages = [
      // ★ 追加：systemで言語固定を強制
        {
        role: "system",
        content: `You must produce output STRICTLY and EXCLUSIVELY in ${outLangName}. Do not write or include any other language. Mixed-language or bilingual responses are FORBIDDEN.`,
      },
      {
        role: "system",
        content: `You are a professional comedy writer. Write a complete Manzai script only in ${outLangName}, ready for performance. Do NOT include translations, explanations, or other languages.`,
      },
      { role: "user", content: prompt },
    ];
   
    const payload = {
      model: process.env.XAI_MODEL || "grok-4-fast-reasoning",
      messages,
      temperature: 0.,
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

    /* === ★ 追加：指定文字数の90%未満なら絶対にクレジットを減らさない === */
    const minRequired = Math.floor(targetLen * 0.9);
    if (body.length < minRequired) {
      // クレジット消費なしで、そのまま本文を返却
      return res.status(200).json({
        title: title || "（タイトル未設定）",
        text: body || "（ネタの生成に失敗しました）",
        meta: {
          structure: structureMeta,
          techniques: techniquesForMeta,
          usage_count: (await getUsageRow(user_id)).output_count ?? null,
          paid_credits: (await getUsageRow(user_id)).paid_credits ?? null,
          target_length: targetLen,
          min_length: minLen,
          max_length: maxLen,
          actual_length: body.length,
          credit_consumed: false,
          reason: "below_90_percent",
        },
      });
    }
    /* === ★ 追加ここまで === */

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
        credit_consumed: true,
      },
    });
  } catch (err) {
    const e = normalizeError(err);
    console.error("[handler error]", e);
    // 失敗：もちろん消費しない
    return res.status(500).json({ error: "Server Error", detail: e });
  }
}