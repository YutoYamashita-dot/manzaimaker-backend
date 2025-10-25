// api/generate.js
// Vercel Node.js (ESM)。本文と「タイトル」を日本語で返す（台本のみ）
// 必須: OPENAI_API_KEY
// 任意: OPENAI_MODEL（未設定なら gpt-4o）

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

/* =========================
 1. 技法 定義テーブル（削除せず維持）
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
  ODOROKI_GIMON: "驚き・疑問ツッコミ：観客の代弁として即時の驚き・疑問でズレを顕在化。",
  AKIRE_REISEI: "呆れ・冷静ツッコミ：感情を抑えた冷静な態度で境界線を描く。",
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
 3) 軽い整形ユーティリティ
========================= */
function ensureTsukkomiOutro(text, tsukkomiName = "B") {
  const outro = `${tsukkomiName}: もういいよ`;
  if (!text) return outro;
  if (/もういいよ\s*$/.test(text)) return text;
  return text.replace(/\s*$/, "") + "\n" + outro;
}

function normalizeSpeakerColons(s) {
  return s.replace(/(^|\n)([^\n:：]+)[：:]\s*/g, (_m, head, name) => `${head}${name}: `);
}

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
    const nextIsTurn = next != null && /^[^:\n：]+:\s/.test((next || "").trim());
    if (isTurn && nextIsTurn) {
      if (cur.trim() !== "" && (next || "").trim() !== "") out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function splitTitleAndBody(s) {
  if (!s) return { title: "", body: "" };
  const parts = s.split(/\r?\n\r?\n/, 2);
  const title = (parts[0] || "").trim().replace(/^【|】$/g, "");
  const body = (parts[1] ?? s).trim();
  return { title, body };
}

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
 4) プロンプト生成（最初の指定文字数のみ利用）
========================= */
function buildPrompt({ theme, genre, characters, length, selected }) {
  const safeTheme = theme?.toString().trim() || "身近な題材";
  const safeGenre = genre?.toString().trim() || "一般";
  const names = (characters?.toString().trim() || "A,B")
    .split(/[、,]/).map((s) => s.trim()).filter(Boolean).slice(0, 4);

  const targetLen = Math.min(Number(length) || 350, 2000);

  const hasNewSelection =
    (selected?.boke?.length || 0) + (selected?.tsukkomi?.length || 0) + (selected?.general?.length || 0) > 0;

  let guideline = "";
  if (hasNewSelection) {
    guideline = buildGuidelineFromSelections(selected);
  } else {
    const usedTechs = pickTechniquesWithMetaphor();
    guideline =
      "【採用する技法（自動選択）】\n" + usedTechs.map((t) => `- ${t}`).join("\n");
  }

  const tsukkomiName = names[1] || "B";

  const prompt = [
    "あなたは実力派の漫才師コンビです。日本語の漫才台本を作成してください。",
    "",
    `■題材: ${safeTheme}`,
    `■ジャンル: ${safeGenre}`,
    `■登場人物: ${names.join("、")}`,
    `■目標文字数: 約 ${targetLen} 文字（本文全体の分量の目安として守る）`,
    "",
    "■必須の構成",
    "- 1) フリ（導入）",
    "- 2) 伏線回収",
    "- 3) 最後は明確な“オチ”",
    "",
    "■選択された技法（技法の名称は本文に出さないこと）",
    guideline || "（特に指定なし）",
    "",
    "■形式",
    "- 各台詞は「名前: セリフ」（半角コロン＋半角スペース）",
    "- 台詞と台詞の間に空行を1つ入れる",
    "- 解説・メタ記述は禁止。本文のみ",
    `- 最後は必ず ${tsukkomiName}: もういいよ で締める`,
    "",
    "■見出し",
    "- 最初の1行に【タイトル】、その後に本文（会話）を続ける",
  ].join("\n");

  return { prompt, tsukkomiName, targetLen, guideline };
}

/* =========================
 5) OpenAI (ChatGPT) 呼び出し
========================= */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
 6) 失敗理由の整形
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
 7) HTTP ハンドラ（生成のみ・シンプル）
========================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { theme, genre, characters, length, boke, tsukkomi, general } = req.body || {};

    const { prompt, tsukkomiName, targetLen, guideline } = buildPrompt({
      theme, genre, characters, length,
      selected: {
        boke: Array.isArray(boke) ? boke : [],
        tsukkomi: Array.isArray(tsukkomi) ? tsukkomi : [],
        general: Array.isArray(general) ? general : [],
      },
    });

    // 安全側にクランプ（日本語1文字≒3tokens、かつプロンプト分を考慮）
    const approxMaxTok = Math.min(3000, Math.ceil(Math.max(targetLen, 300) * 3));

    const messages = [
      { role: "system", content: "あなたは実力派の漫才師コンビです。舞台で即使える台本だけを出力してください。解説・メタ記述は禁止。" },
      { role: "user", content: prompt },
    ];

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-5",
        messages,
        max_completion_tokens: approxMaxTok,
      });
    } catch (err) {
      const e = normalizeError(err);
      console.error("[openai error]", e);
      return res.status(e.status || 500).json({ error: "OpenAI request failed", detail: e });
    }

    // 整形（後処理での再カットや追記はしない）
    let raw = completion?.choices?.[0]?.message?.content?.trim() || "";
    let { title, body } = splitTitleAndBody(raw);
    body = normalizeSpeakerColons(body);
    body = ensureBlankLineBetweenTurns(body);
    body = ensureTsukkomiOutro(body, tsukkomiName);

    const success = typeof body === "string" && body.trim().length > 0;
    if (!success) return res.status(500).json({ error: "Empty output" });

    return res.status(200).json({
      title: title || "（タイトル未設定）",
      text: body,
      meta: {
        techniques: guideline ? guideline.split("\n").filter(Boolean) : [],
        target_length: targetLen,
        actual_length: body.length,
      },
    });
  } catch (err) {
    const e = normalizeError(err);
    console.error("[handler error]", e);
    return res.status(500).json({ error: "Server Error", detail: e });
  }
}
