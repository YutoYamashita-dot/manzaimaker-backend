// api/generate.js (ESM)
import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { theme, genre, characters, length } = req.body || {};
    if (!theme || !genre || !characters || !length) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `以下の条件で漫才ネタを書いてください。
【テーマ】${theme}
【ジャンル】${genre}
【登場人物】${characters}
【構成】緊張と緩和、風刺、皮肉、意外性と納得感、伏線回収といったお笑いの理論を使用し、ハルシネーションなしで、現実に即して、きれいな展開にしてください。最後にしっかりオチをつけてください。人間が作るような滑らかな展開、文章にしてください。
【長さ】合計で「${length}文字以上${length + 50}文字以下」にしてください。必ず指定範囲内に収めてください。
【追加条件】出力の最後に「（文字数：XXXX文字）」と明記してください。
【注意】最後に漫才の構成を示してください。`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const text = resp.choices?.[0]?.message?.content ?? "";
    return res.status(200).json({ text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
