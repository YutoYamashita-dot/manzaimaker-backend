// api/generate.js
// Vercel Node.js (ESM)。本文のみを日本語で返す（台本だけ）
// 必須: 環境変数 XAI_API_KEY
// 任意: 環境変数 XAI_MODEL（未設定なら grok-4）

export const config = { runtime: "nodejs" };

import OpenAI from "openai";

/* =========================
   1) 技法 定義テーブル（Android側 Enum 名に対応）
   ========================= */
const BOKE_DEFS = {
  IIMACHIGAI:
    "言い間違い／聞き間違い：音韻のズレで意外性を生む（例：「カニ食べ行こう」→「紙食べ行こう？」）。",
  HIYU: "比喩ボケ：日常を比喩で誇張（例：「あいつカフェインみたいに効かない」）。",
  GYAKUSETSU: "逆説ボケ：一見正論に聞こえるが論理が破綻している。",
  GIJI_RONRI:
    "擬似論理ボケ：論理風だが中身がズレている（例：「犬は四足、だから社長」）。",
  TSUKKOMI_BOKE: "ツッコミボケ：ツッコミの発言が次のボケの伏線になる構造。",
  RENSA:
    "ボケの連鎖：ボケが次のボケを誘発するように連続させ、加速感を生む。",
  KOTOBA_ASOBI: "言葉遊び：ダジャレ・韻・多義語などの言語的転倒。",
};

const TSUKKOMI_DEFS = {
  ODOROKI_GIMON:
    "驚き・疑問ツッコミ：観客の代弁として即時の驚き・疑問でズレを顕在化。",
  AKIRE_REISEI:
    "呆れ・冷静ツッコミ：感情を抑えた冷静な態度で境界線を描く。",
  OKORI: "怒りツッコミ：強めの感情でズレを是正し笑いの対象を明確化。",
  KYOKAN:
    "共感ツッコミ：観客の立場・感情を代弁して共感の中で笑いを起こす。",
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
   2) 旧仕様用：ランダム技法（「比喩ツッコミ」を必ず含む）
   ========================= */
const MUST_HAVE_TECH = "比喩ツッコミ";
function pickTechniquesWithMetaphor() {
  const pool = ["風刺", "皮肉", "意外性と納得感", "勘違い→訂正", "言い間違い→すれ違い", "立場逆転", "具体例の誇張"];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const extraCount = Math.floor(Math.random() * 3) + 1; // 1〜3
  return [MUST_HAVE_TECH, ...shuffled.slice(0, extraCount)]; // 合計2〜4
}

/* =========================
   3) 文字数の最終調整（末尾が不自然なら一文補う版）
   ========================= */
function enforceCharLimit(text, maxLen) {
  if (!text) return "";
  let t = text
    .trim()
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .trim();

  if (t.length > maxLen) {
    const softCut = t.lastIndexOf("\n", maxLen);
    const softPuncs = ["。", "！", "？", "…", "♪"];
    const softPuncCut = Math.max(...softPuncs.map((p) => t.lastIndexOf(p, maxLen)));
    let cutPos = Math.max(softPuncCut, softCut);
    if (cutPos < maxLen * 0.7) cutPos = maxLen;
    t = t.slice(0, cutPos).trim();
    if (!/[。！？…♪]$/.test(t)) t += "。";
  }

  // 最後が導入やツッコミで終わっている場合に軽く畳む（任意）
  if (!/[。！？…♪]$/.test(t)) t += "。";
  return t;
}

/* =========================
   4) ガイドライン生成（選択技法→定義を埋め込む）
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
    "■選択された技法ガイドライン（必ず本文で顕在化。名称は本文に書かない）",
    guideline || "（特に指定なし。自然に面白く）",
    "",
    "■文体・出力ルール",
    "- 会話主体で、人間が書いたような自然なテンポ・言い回しにする",
    "- 登場人物のキャラクター性を反映させる",
    "- ボケとツッコミの役割を明快にする",
    "- 人間にとって「意外性」があるが「納得感」のある表現の仕組みにする。しかし、「意外性」や「納得感」と直接本文に書かない。",
    "- 「皮肉」や「比喩」や「風刺」と直接本文に書かない。",
    "- 差別的表現は避ける",
    "- **出力は本文のみ**。解説・注釈・見出し・『文字数：◯◯』等は書かない",
    "- 例: `A: ...\\nB: ...\\nA: ...` のように台詞ごとに改行",
  ].join("\n");

  return { prompt, techniquesForMeta, structureMeta, maxLen };
}

/* =========================
   6) Grok(xAI) 呼び出し（OpenAI SDK互換）
   ========================= */
const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY, // ← xAIのAPIキー
  baseURL: "https://api.x.ai/v1", // ← /v1 を明示
});
const MODEL = process.env.XAI_MODEL || "grok-4";

/* 失敗理由を分かりやすくする正規化 */
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
   7) HTTP ハンドラ
   ========================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { theme, genre, characters, length, boke, tsukkomi, general } = req.body || {};

    const { prompt, techniquesForMeta, structureMeta, maxLen } = buildPrompt({
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
          "あなたは実力派の漫才師コンビです。舞台で即使える台本だけを出力してください。メタ説明は禁止。",
      },
      { role: "user", content: prompt },
    ];

    // ========== 追加: payloadBase ==========
    const payloadBase = {
      messages,
      temperature: 0.8,
      max_tokens: 10000, // ← 少し余裕
    };

    let completion;
    try {
      completion = await client.chat.completions.create({
        ...payloadBase,
        model: MODEL, // "grok-4"
      });
    } catch (err) {
      const e = normalizeError(err);
      console.error("[xAI error]", e);
      return res.status(e.status || 500).json({
        error: "xAI request failed",
        detail: e, // ← ステータス・メッセージ・data を含む
      });
    }

    const text = completion?.choices?.[0]?.message?.content?.trim() || "";
    const finalText = enforceCharLimit(text, maxLen);

    return res.status(200).json({
      text: finalText || "（ネタの生成に失敗しました）",
      meta: {
        structure: structureMeta,
        techniques: techniquesForMeta,
      },
    });
  } catch (err) {
    const e = normalizeError(err);
    console.error("[handler error]", e);
    return res.status(500).json({ error: "Server Error", detail: e });
  }
}