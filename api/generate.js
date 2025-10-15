// api/generate.js
// Vercel Node.js (ESM)。本文のみを日本語で返す（台本だけ）
// 必須: 環境変数 OPENAI_API_KEY
// 仕様: まず gpt-5 を試し、使えない場合は gpt-4o-mini に自動フォールバック

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

// ---- 技法選択：必ず「比喩ツッコミ」を含め、総数は 2〜4 個 ----
// ※ 「緊張」「緩和」という語は使わず、内容の展開で表す前提。
const MUST_HAVE_TECH = "比喩ツッコミ";
function pickTechniquesWithMetaphor() {
  const pool = [
    "風刺",
    "皮肉",
    "意外性と納得感",
    "勘違い→訂正",
    "言い間違い→すれ違い",
    "立場逆転",
    "具体例の誇張",
    // "比喩ツッコミ" は必須枠なのでプールから外す
  ];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  // MUST_HAVE_TECH を含めた総数が 2〜4 になるよう、追加分は 1〜3 個
  const extraCount = Math.floor(Math.random() * 3) + 1; // 1〜3
  const extras = shuffled.slice(0, extraCount);
  // 先頭に必須を固定配置
  return [MUST_HAVE_TECH, ...extras];
}

// ---- 文字数の最終調整（上限を厳守）----
function enforceCharLimit(text, maxLen) {
  if (!text) return "";
  let t = text.trim();

  // 台本以外の装飾を念のため除去
  t = t.replace(/```[\s\S]*?```/g, "").trim();
  t = t.replace(/^#{1,6}\s.*$/gm, "").trim();

  if (t.length <= maxLen) return t;

  // 改行・句読点の手前で切る
  const softCut = t.lastIndexOf("\n", maxLen);
  const softPuncs = ["。", "！", "？", "…", "♪"];
  const softPuncCut = Math.max(...softPuncs.map((p) => t.lastIndexOf(p, maxLen)));

  let cutPos = Math.max(softPuncCut, softCut);
  if (cutPos < maxLen * 0.7) cutPos = maxLen; // なければハードカット
  let out = t.slice(0, cutPos).trim();

  if (!/[。！？…♪]$/.test(out)) out += "。";
  return out;
}

// ---- プロンプト生成（フリ／伏線回収／オチ必須 + “語を使わず”張り→解放）----
// ※ 返値で構成と採用技法も返す
function buildPrompt({ theme, genre, characters, length }) {
  const safeTheme = theme && String(theme).trim() ? String(theme).trim() : "身近な題材";
  const safeGenre = genre && String(genre).trim() ? String(genre).trim() : "一般";
  const names = (characters && String(characters).trim() ? String(characters).trim() : "A,B")
    .split(/[、,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const targetLen = Math.min(Number(length) || 350, 2000);

  // ★ 今回採用する技法（必ず「比喩ツッコミ」を含む 2〜4 個）
  const usedTechs = pickTechniquesWithMetaphor();

  const minLen = Math.max(100, Math.floor(targetLen * 0.9));
  const maxLen = targetLen;

  const prompt = [
    "あなたは実力派の漫才師コンビです。自分たちの舞台用に日本語で漫才の台本（本文のみ）を作成してください。",
    "",
    `■題材: ${safeTheme}`,
    `■ジャンル: ${safeGenre}`,
    `■登場人物: ${names.join("、")}`,
    `■目標文字数: ${minLen}〜${maxLen}文字（絶対に超過しない）`,
    "",
    "■必須の構成",
    "- 1) フリ（導入の仕込み）…後半の展開に効く情報を自然に提示",
    "- 2) 伏線回収…前半の仕込みを後半で回収して気持ちよく接続",
    "- 3) 最後は明確な“オチ”で締める（余韻よりも落ちを優先）",
    "",
    "■必須の演出（語は出さないこと）",
    "- 台本中に、“ピリつく・焦る・気まずい・誤解で困る”等の**張り詰めた状態**を一度作る",
    "- その後、誤解が解ける・立場が変わる・勘違いに気づく・期待を裏切るが納得できる等で**空気が和らぐ状態**を作る",
    "- **本文に『緊張』『緩和』という単語は出さない**（展開で表現する）",
    "",
    "■採用する技法（**必ず『比喩ツッコミ』を含め、合計2〜4個**）",
    `- ${usedTechs.join("／")}`,
    "",
    "■文体・出力ルール",
    "- 会話主体で、人間が書いたような自然なテンポ・言い回しにする",
    "- キャラの口調・立場は一貫（例：ボケは畳みかけ、ツッコミは明快に）",
    "- センシティブ／差別的表現は避け、固有名詞は一般化する",
    "- **出力は本文のみ**。解説・注釈・見出し・『文字数：◯◯』等は書かない",
    "- 例: `A: ...\\nB: ...\\nA: ...` のように台詞ごとに改行",
  ].join("\n");

  // 画面の下部に出したい構成名（固定）
  const structure = ["フリ", "伏線回収", "最後のオチ", "張り→解放"];

  return { prompt, usedTechs, structure, maxLen };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 利用する優先モデル（環境で上書き可）
const PREFERRED_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const FALLBACK_MODEL = "gpt-4o-mini";

async function createWithFallback(payloadBase) {
  try {
    return await openai.chat.completions.create({ ...payloadBase, model: PREFERRED_MODEL });
  } catch (e) {
    console.warn(
      `[generate] primary model failed (${PREFERRED_MODEL}). Fallback to ${FALLBACK_MODEL}.`,
      e?.message || e
    );
    return await openai.chat.completions.create({ ...payloadBase, model: FALLBACK_MODEL });
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { theme, genre, characters, length } = req.body || {};
    const { prompt, usedTechs, structure, maxLen } = buildPrompt({
      theme,
      genre,
      characters,
      length,
    });

    const payloadBase = {
      messages: [
        {
          role: "system",
          content:
            "あなたは実力派の漫才師コンビです。舞台で即使える台本だけを出力してください。メタ説明は禁止。禁止語:『緊張』『緩和』。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 1400,
    };

    const completion = await createWithFallback(payloadBase);

    let text = completion?.choices?.[0]?.message?.content?.trim() || "（ネタの生成に失敗しました）";
    const finalText = enforceCharLimit(text, maxLen);

    return res.status(200).json({
      text: finalText,
      meta: {
        structure,          // ["フリ","伏線回収","最後のオチ","張り→解放（単語は出さない）"]
        techniques: usedTechs, // 先頭に常に「比喩ツッコミ」を含む
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server Error" });
  }
}