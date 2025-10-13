// api/generate.js
// Vercel (Node.js) 用 API ルート。ESM 前提（package.json に "type": "module"）。
// OpenAI SDK v4（npm: openai）を使用します。

import OpenAI from "openai";

// Vercel の Node.js ランタイムを明示（"nodejs18.x" のような古い値は NG なので注意）
export const config = { runtime: "nodejs" };

// ===== ユーティリティ: 文字数（コードポイント）を厳密に数える =====
function codePointLength(str) {
  // 改行は文字数カウントから除外したい場合はここで除去
  const cleaned = str.replace(/\r/g, "").replace(/\n/g, "");
  return Array.from(cleaned).length;
}

// （必要があれば）最大コードポイント数で丸める
function clampByCodepoints(str, max) {
  const arr = Array.from(str);
  return arr.length <= max ? str : arr.slice(0, max).join("") + "…";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const {
      theme,
      genre,
      characters,
      length,
      mustInclude = [],      // 任意: クライアントが必須要素を追加したい場合
      withStructure = true,  // 任意: 構成説明を付けるか（デフォルト付ける）
    } = (await parseJson(req)) ?? {};

    if (!theme || !genre || !characters || !length) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 文字数は 100〜2000 の範囲にクランプ
    const len = Math.min(Math.max(parseInt(length, 10) || 350, 100), 2000);

    // ランダムに追加するオプション要素（毎回シャッフル）
    const optionalPool = ["風刺", "皮肉", "意外性と納得感"];
    const shuffled = [...optionalPool].sort(() => Math.random() - 0.5);
    const optionalCount = Math.floor(Math.random() * (optionalPool.length + 1)); // 0〜3
    const randomPicked = shuffled.slice(0, optionalCount);

    // 必須セットを作成：ユーザー指定 + 「緊張と緩和」 + ランダム要素
    const musts = Array.from(new Set([...(mustInclude || []), "緊張と緩和", ...randomPicked]));

    // OpenAI
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    const system = [
      "あなたは日本語の放送作家です。人間らしい自然な会話文で漫才ネタを書きます。",
      "必ず 2000 文字以内で書きます。",
      `必須要素は「${musts.join("」「")}」です（最低でも「緊張と緩和」は必ず含めること）。`,
      "必ず『伏線回収』と『最後のオチ』を入れます。",
      "A/B の掛け合いを主体に。読みやすさ最優先（見出しや過剰な装飾は控えめに）。",
    ].join("\n");

    const user = [
      "【条件】",
      `- テーマ: ${theme}`,
      `- ジャンル: ${genre}`,
      `- 登場人物: ${characters}`,
      `- 目安文字数: 約${len}文字以内`,
      withStructure
        ? "- 出力の最後に、簡潔な構成を「### 構成」見出しで付ける（導入/緊張と緩和/伏線回収/オチ 等を短く箇条書き）"
        : "- 構成説明は不要",
      "",
      "【出力形式】",
      "1) 最初に漫才ネタ本文（A: / B: の掛け合い中心）",
      "2) （本文の後）空行を1つ開けてから、（文字数：N文字）と明記（Nは本文の厳密な文字数: 改行除外・装飾除去後のコードポイント数）",
      withStructure ? "3) その後に「### 構成」セクション" : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Responses API（SDK v4）。output_text がまとめて取れるので扱いが簡単です。
    const ai = await client.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const raw = (ai.output_text || "").trim();
    if (!raw) {
      return res.status(502).json({ error: "Empty model output" });
    }

    // 「### 構成」以降を分離。文字数は“本文のみ”で厳密カウント。
    const parts = raw.split(/\n###\s*構成/i);
    let scriptPart = parts[0].trim();
    const structurePart = parts[1] ? `### 構成${parts[1]}` : "";

    // 2000文字を超える場合は本文を安全に丸める（コードポイント単位）
    // ※ 厳密上限は 2000、必要に応じて len に合わせて丸める
    const HARD_MAX = 2000;
    if (codePointLength(scriptPart) > HARD_MAX) {
      scriptPart = clampByCodepoints(scriptPart, HARD_MAX);
    }

    // 厳密カウント（改行除外 & 装飾弱めに除去）→ クライアントでも再カウントして二重で安全
    const forCount = scriptPart
      .replace(/\*\*|__/g, "") // 太字マークダウンの除去
      .replace(/\r/g, "")
      .replace(/\n/g, "");
    const counted = Array.from(forCount).length;

    const finalOut = [
      scriptPart,
      "",
      `（文字数：${counted}文字）`,
      "",
      structurePart.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ text: finalOut, usedMusts: musts });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

// ---- VercelのNode APIは req.body を自動でパースしないことがあるので安全にJSONを読む ----
async function parseJson(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const str = Buffer.concat(chunks).toString("utf8");
    if (!str) return {};
    return JSON.parse(str);
  } catch {
    return {};
  }
}