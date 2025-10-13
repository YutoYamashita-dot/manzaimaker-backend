// Vercel /api/generate エンドポイント（Node.js）
// - elements を受け取りプロンプトへ反映
// - 出力は 2000 文字以下に強制
// - 最後に（文字数：XXXX文字）をサーバ側で正確に付け直す（モデルの記載に依存しない）
// - OPENAI_API_KEY は Vercel の Environment Variables に設定

export const config = {
  runtime: 'nodejs18.x',
};

import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 文字数を 2000 に制限しつつ、できれば行末で気持ちよく切る
function hardCapTo2000Chars(text, cap = 2000) {
  if (!text) return '';
  if (text.length <= cap) return text;

  // 直前の改行で切る（なければそのままカット）
  const cutoff = text.lastIndexOf('\n', cap - 10);
  const slicePoint = cutoff > 0 ? cutoff : cap;
  const trimmed = text.slice(0, slicePoint);
  return trimmed + '\n（※上限に達したため一部省略）';
}

// 末尾の（文字数：XXXX文字）を一旦削除して、正しい値で付け直す
function rewriteCharCountFooter(text) {
  if (!text) return '（文字数：0文字）';

  // 既存の「（文字数：...文字）」を取り除く
  const cleaned = text.replace(/（文字数：\d+文字）\s*$/u, '').trimEnd();

  // ここで計測（全角・半角ともに JS の文字数基準＝UTF-16 コードユニット基準）
  const count = cleaned.length;

  return `${cleaned}\n\n（文字数：${count}文字）`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { theme, genre, characters, length, elements } = req.body || {};

    // 入力チェック
    if (
      typeof theme !== 'string' ||
      typeof genre !== 'string' ||
      typeof characters !== 'string' ||
      (typeof length !== 'number' && typeof length !== 'string')
    ) {
      return res.status(400).json({ error: 'Missing or invalid fields' });
    }

    // 数値化＆上限 2000
    let targetLen = Number(length);
    if (!Number.isFinite(targetLen) || targetLen <= 0) targetLen = 300; // デフォルト
    if (targetLen > 2000) targetLen = 2000;

    // elements は配列想定（クライアントがランダム選定）
    const safeElements =
      Array.isArray(elements) && elements.length > 0
        ? elements
        : ['緊張と緩和']; // フォールバック（最低1つ）

    // 指示文を作成（伏線回収と最後のオチは常に必須）
    const prompt = `
以下の条件で漫才ネタを書いてください。

【テーマ】${theme}
【ジャンル】${genre}
【登場人物】${characters}
【構成】「伏線回収」と「最後のオチ」を必ず入れてください。
また、次の4つの理論のうち、クライアントから指定されたもの **だけ** を使ってください：
- 緊張と緩和
- 風刺
- 皮肉
- 意外性と納得感

今回、使う理論（指定）: ${safeElements.join('、')}

【長さ】合計で「${targetLen}文字」以上「${Math.min(
      targetLen + 50,
      2000
    )}文字」以下にしてください（絶対に2000文字を超えないでください）。
【追加条件】出力の最後に「（文字数：XXXX文字）」と明記してください（XXXXは実際の文字数）。
【注意】ハルシネーションなしで、現実に即して、人間が作るような滑らかな展開にしてください。最後に漫才の構成（箇条書き）も示してください。
`.trim();

    // OpenAI 呼び出し
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini', // コスト・速度優先の軽量モデル例。必要に応じて変更可。
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content:
            'あなたは日本語のお笑い脚本のプロです。事実に反する断定や固有名詞の創作は避け、常識の範囲で現実に即した内容にしてください。',
        },
        { role: 'user', content: prompt },
      ],
    });

    let text =
      completion.choices?.[0]?.message?.content?.trim() ||
      '生成に失敗しました。時間をおいて再度お試しください。';

    // 物理上限 2000 をサーバで強制
    text = hardCapTo2000Chars(text, 2000);

    // 末尾の（文字数：XXXX文字）を正しい値で付け直し
    text = rewriteCharCountFooter(text);

    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: 'Server error',
      detail: err?.message ?? String(err),
    });
  }
}