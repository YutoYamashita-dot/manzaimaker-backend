// api/generate.js
import { z } from "zod";
import OpenAI from "openai";

/**
 * ★このAPIの役割：
 * AndroidアプリなどからPOSTされた「テーマ・ジャンル・登場人物・文字数」を受け取り、
 * ChatGPT API にリクエストして、漫才ネタを生成して返します。
 */

// ---- 入力バリデーション（Zodで安全にチェック） ----
const schema = z.object({
  theme: z.string().min(1).max(60),
  genre: z.string().min(1).max(30),
  characters: z.string().max(60).optional(),
  length: z.number().int().min(1).max(2000), // ユーザー指定の文字数（1〜2000）
});

// ---- 日本語文字数を数える関数（サロゲート対応） ----
const countChars = (s) => [...(s ?? "")].length;

// ---- 末尾の「（文字数：XXXX文字）」行を除去する関数 ----
const stripTrailingCountLine = (text) => {
  if (!text) return { body: "", lastLine: "" };
  const lines = text.trimEnd().split(/\r?\n/);
  const last = lines[lines.length - 1] || "";
  const body = last.startsWith("（文字数：") ? lines.slice(0, -1).join("\n") : text;
  return { body, lastLine: last };
};

// ---- システムプロンプト（AIへの“役割説明”） ----
const SYSTEM_PROMPT =
  "あなたは日本の漫才作家です。ユーザーの指示に厳密に従い、" +
  "緊張と緩和、風刺、皮肉、意外性と納得感、伏線回収を用いて、" +
  "現実に即し、きれいな展開で最後に必ずオチを付けた台本を作成します。";

// ---- ユーザーの入力をもとにプロンプトを組み立てる関数 ----
const buildUserPrompt = ({ theme, genre, characters, minUser, maxUser }) => {
  const 登場人物 = (characters && characters.trim().length > 0)
    ? `【登場人物】${characters.trim()}`
    : "【登場人物】（必要ならここに人物を指定）";

  return `
以下の条件で漫才ネタを書いてください。

【テーマ】${theme}
【ジャンル】${genre}
${登場人物}
【構成】緊張と緩和、風刺、皮肉、意外性と納得感、伏線回収といったお笑いの理論を使用し、ハルシネーションなしで、現実に即して、きれいな展開にしてください。最後にしっかりオチをつけてください。人間が作るような滑らかな展開、文章にしてください。
【長さ】合計で**「任意の2000文字以内(ユーザー指定)」の文字以上「任意の2000文字以内(ユーザー指定)」の文字+50文字以下**にしてください。必ず指定範囲内に収めてください。
※ この依頼における実際の最小文字数は「${minUser}」で、最大文字数は「${maxUser}」です。上限は「${maxUser + 50}」です。本文の長さは必ず ${minUser} 以上 ${maxUser + 50} 以下にしてください。
【追加条件】出力の最後に「（文字数：XXXX文字）」と明記してください。XXXXは本文（この指示文や構成表示を除いた台本本文）の実際の文字数にしてください。
【注意】最後に漫才の構成を示してください。

出力は台本本文と末尾の文字数表記、および最後に構成のみを示してください。余計な説明や前置きは書かないでください。
`.trim();
};

// ---- メイン処理（Vercelのサーバーレス関数） ----
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    // ✅ リクエスト内容を検証
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    }

    const { theme, genre, characters, length } = parsed.data;
    const minUser = length;
    const maxUser = length;
    const upper = maxUser + 50;

    // ✅ OpenAIクライアント初期化（APIキーはVercelの環境変数から）
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ✅ ユーザー向けプロンプトを組み立て
    const userPrompt = buildUserPrompt({ theme, genre, characters, minUser, maxUser });

    // ---- 1回目の生成 ----
    const genOnce = async (messages, temperature = 0.7) => {
      const r = await client.chat.completions.create({
        model: "gpt-5",
        temperature,
        messages,
        timeout: 25_000,
      });
      return (r.choices?.[0]?.message?.content ?? "").trim();
    };

    let text = await genOnce([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ]);

    // ✅ 文字数チェック
    let { body } = stripTrailingCountLine(text);
    let n = countChars(body);
    let needFix = !(n >= minUser && n <= upper);

    // ---- 1回だけ自動リライト（文字数が範囲外のとき）----
    if (needFix) {
      const fixPrompt = `上記の台本本文の文字数を必ず ${minUser} 以上 ${upper} 以下に厳密に調整し、最後に必ず「（文字数：XXXX文字）」と正確な数で追記してください。台本の内容とオチ、流れは保ちつつ微調整のみ行ってください。`;
      text = await genOnce([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
        { role: "assistant", content: text },
        { role: "user", content: fixPrompt }
      ], 0.2);

      ({ body } = stripTrailingCountLine(text));
      n = countChars(body);
      needFix = !(n >= minUser && n <= upper);
    }

    // ✅ それでもダメならエラーで返す
    if (needFix) {
      return res.status(422).json({ error: "length_out_of_range", note: `got:${n}, required:[${minUser}, ${upper}]` });
    }

    // ✅ 正常レスポンス
    return res.status(200).json({ text, count: n, target: length, maxPlus50: upper });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "generation_failed", detail: e.message });
  }
}
