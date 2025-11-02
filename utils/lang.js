// utils/lang.js
// 多言語サポート（主要30言語）＋ Accept-Language / 明示lang の正規化

import Negotiator from "negotiator";

/** サポートする“基準”言語コード（30言語） */
export const SUPPORTED_LANGS = [
  "en",      // English
  "ja",      // Japanese
  "zh-CN",   // Chinese (Simplified)
  "zh-TW",   // Chinese (Traditional)
  "ko",      // Korean
  "es",      // Spanish
  "fr",      // French
  "de",      // German
  "pt",      // Portuguese (Portugal/Generic)
  "pt-BR",   // Portuguese (Brazil)
  "it",      // Italian
  "ru",      // Russian
  "uk",      // Ukrainian
  "ar",      // Arabic
  "hi",      // Hindi
  "id",      // Indonesian
  "ms",      // Malay
  "th",      // Thai
  "vi",      // Vietnamese
  "tr",      // Turkish
  "nl",      // Dutch
  "pl",      // Polish
  "sv",      // Swedish
  "da",      // Danish
  "no",      // Norwegian (Bokmål/Nynorsk統合)
  "fi",      // Finnish
  "he",      // Hebrew
  "el",      // Greek
  "cs",      // Czech
  "hi", 
  "ro"       // Romanian
];

/** プロンプトで使う“言語名”（英語表記推奨：モデルが誤解しにくい） */
export const LANG_NAME = {
  "en":    "English",
  "ja":    "Japanese",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  "ko":    "Korean",
  "es":    "Spanish",
  "fr":    "French",
  "de":    "German",
  "pt":    "Portuguese",
  "pt-BR": "Portuguese (Brazil)",
  "it":    "Italian",
  "ru":    "Russian",
  "uk":    "Ukrainian",
  "ar":    "Arabic",
  "hi":    "Hindi",
  "id":    "Indonesian",
  "ms":    "Malay",
  "th":    "Thai",
  "vi":    "Vietnamese",
  "tr":    "Turkish",
  "nl":    "Dutch",
  "pl":    "Polish",
  "sv":    "Swedish",
  "da":    "Danish",
  "no":    "Norwegian",
  "fi":    "Finnish",
  "he":    "Hebrew",
  "el":    "Greek",
  "cs":    "Czech",
  "ro":    "Romanian"
};

/** 役名タグ（既存generate.jsが .boke / .tsukkomi を参照する想定） */
export const SPEAKER_TAGS = {
  boke: "[Boke]",
  tsukkomi: "[Tsukkomi]"
};

/** 地域・別名を“基準コード”に正規化する */
function normalizeLangCode(input) {
  if (!input) return null;
  let tag = String(input).replace("_", "-").toLowerCase();

  // よくあるエイリアス（まずは個別置換）
  const ALIAS = {
    // Chinese
    "zh": "zh-cn",
    "zh-hans": "zh-cn",
    "zh-cn": "zh-cn",
    "zh-sg": "zh-cn",
    "zh-my": "zh-cn",
    "zh-hant": "zh-tw",
    "zh-tw": "zh-tw",
    "zh-hk": "zh-tw",

    // Portuguese
    "pt-pt": "pt",
    "pt": "pt",
    "pt-br": "pt-br",

    // Norwegian
    "nb": "no",
    "nn": "no",
    "no": "no"
  };

  if (ALIAS[tag]) tag = ALIAS[tag];

  // region 付き → primary も拾えるように
  const primary = tag.split("-")[0];

  // SUPPORTED にそのままあるか？
  const asIs = SUPPORTED_LANGS.find(c => c.toLowerCase() === tag);
  if (asIs) return asIs;

  // 主要方言マップ（zh / pt / no は上で処理済み）
  // それ以外は primary を採用（例: es-MX → es）
  if (SUPPORTED_LANGS.includes(primary)) return primary;

  // 特別ケース（英語系）
  if (primary === "en") return "en";

  return null; // 見つからなければ呼び出し側でフォールバック
}

/**
 * 言語決定：
 *  - explicit（明示指定: "lang"）を最優先 → 正規化
 *  - それ以外は Accept-Language を優先順に走査して正規化
 *  - 何も当てはまらなければ "en"
 */
export function detectLang(req, explicit) {
  // 明示指定があれば優先
  const exp = normalizeLangCode(explicit);
  if (exp) return exp;

  // Accept-Language を解析
  try {
    const nego = new Negotiator(req);
    const accepted = nego.languages(); // 優先順の配列（例: ['ja-JP','en-US',...]
    for (const tag of accepted) {
      const norm = normalizeLangCode(tag);
      if (norm) return norm;
    }
  } catch {
    /* no-op */
  }

  // 最終フォールバック
  return "en";
}