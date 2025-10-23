import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

const r = await client.chat.completions.create({
  model: "grok-4",
  messages: [
    { role: "system", content: "あなたは日本語の漫才作家です。" },
    { role: "user", content: "テーマは『会社のランチ会』で、短い台本を書いて。" }
  ],
  temperature: 0.8,
  max_tokens: 400
});

console.log(r.choices?.[0]?.message?.content);