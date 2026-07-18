// 候補URLに実際にfetchし、本文テキストから住所キーワードの含有を機械的にチェックするスクリプト。
// 使い方: node fetch-check.mjs <url> <keyword1> <keyword2> ...
import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function main() {
  const url = process.argv[2];
  const keywords = process.argv.slice(3);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    const status = res.status;
    if (!res.ok) {
      console.log(JSON.stringify({ url, status, ok: false }));
      return;
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $("title").text().trim();
    const bodyText = $("body").text().replace(/\s+/g, "");
    const matches = keywords.map((k) => ({ keyword: k, found: bodyText.includes(k) }));
    // アクセス/店舗情報/会社概要 等のリンクを収集
    const links = [];
    $("a").each((_, el) => {
      const t = $(el).text().trim();
      const href = $(el).attr("href");
      if (href && /アクセス|店舗情報|会社概要|所在地|shop|access|about|company/i.test(t)) {
        links.push({ text: t, href });
      }
    });
    console.log(JSON.stringify({ url, status, ok: true, title, matches, candidateLinks: links.slice(0, 15) }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ url, ok: false, error: e.message }));
  }
}
main();
