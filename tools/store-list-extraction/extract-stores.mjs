// 眉毛サロン比較メディア(eyebrow-navi.com)の全記事から店舗候補を抽出する一回限りのスクリプト
// WordPress REST API(公開・認証不要)で全記事を取得し、各記事内の店舗情報テーブル(<td>店舗名</td>を含むtable)
// を検出して、テーブル内のラベル付き行から予約ページ(HPB)/公式サイトのリンクを直接抽出する。
// 見出しテキストだけでなく「実際に店舗情報テーブルが存在するか」を検証してから店舗として採用する。
import { google } from "googleapis";
import * as cheerio from "cheerio";

const WP_BASE = "https://eyebrow-navi.com";
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function normalizeHpbUrl(url) {
  // クエリパラメータ/review等のサブパスのみ除去し、地域プレフィックス(例: /kr/)は保持する
  // (プレフィックスを削除すると404になることを実データで確認済み)
  const clean = url.split("?")[0].split("#")[0];
  const m = clean.match(/^(https:\/\/beauty\.hotpepper\.jp\/(?:[a-z]{2}\/)?sln[A-Za-z0-9]+)/);
  return m ? `${m[1]}/` : clean;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function checkUrlAlive(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    const html = await res.text();
    const expired = /掲載期間が終了|サロンの掲載期間|掲載エラー/.test(html);
    return { status: res.status, alive: res.ok && !expired, expired };
  } catch (e) {
    return { status: 0, alive: false, expired: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAllPosts() {
  const posts = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${WP_BASE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,link,title,content`
    );
    if (!res.ok) break;
    const batch = await res.json();
    if (batch.length === 0) break;
    posts.push(...batch);
    const totalPages = Number(res.headers.get("x-wp-totalpages") || "1");
    if (page >= totalPages) break;
    page++;
  }
  return posts;
}

// ブロックHTML内の<table>行を、テーブルごとに区切って [{label: {text,href}}, ...] の配列で返す。
// 1ブロックに複数の「店舗名」テーブルが連続して存在するケース(次の店舗に見出しが無い)に対応するため、
// 単純な1個のmapに全行を流し込む(同名ラベルが上書きされる)実装から、テーブル単位の配列に変更した。
function parseTableGroups($, blockHtml) {
  const $$ = cheerio.load(`<div>${blockHtml}</div>`);
  const groups = [];
  let current = null;
  $$("table tr").each((_, tr) => {
    const tds = $$(tr).find("td");
    if (tds.length < 2) return;
    const label = $$(tds[0]).text().trim();
    const valueCell = $$(tds[1]);
    const link = valueCell.find("a").attr("href");
    if (label === "店舗名") {
      current = {};
      groups.push(current);
    }
    if (!current) return; // 店舗名より前に出現した行(通常は無い)は無視
    current[label] = { text: valueCell.text().trim(), href: link || null };
  });
  return groups;
}

function extractStoresFromPost(post) {
  const $ = cheerio.load(post.content.rendered);
  const results = [];
  const headingEls = $("h2, h3, h4").toArray();

  headingEls.forEach((el) => {
    const $el = $(el);
    if (el.tagName.toLowerCase() !== "h3") return;

    const heading = $el.text().trim();
    if (!heading) return;

    // 次の見出しまでの兄弟要素をブロックHTMLとして収集
    let html = "";
    let sib = $el.next();
    while (sib.length && !["h2", "h3", "h4"].includes(sib.prop("tagName")?.toLowerCase())) {
      html += $.html(sib);
      sib = sib.next();
    }

    // 1ブロックに「店舗名」テーブルが複数存在する場合(次の店舗に見出しが無いケース)、
    // テーブルごとに別店舗として分割して扱う。見出しテキストは1つ目のテーブルにのみ対応する。
    const groups = parseTableGroups($, html);
    if (groups.length === 0) return; // 店舗テーブルなし = 店舗ではない(A-1判定)
    if (groups.length > 1) {
      console.log(`  [複数店舗検出] 見出し="${heading}" のブロックに${groups.length}店舗分のテーブルを検出 (${post.link})`);
    }

    groups.forEach((rows, gi) => {
      const storeName = rows["店舗名"]?.text || (gi === 0 ? heading : "");
      if (!storeName) return;
      const hpbCell = rows["予約ページ"];
      const officialCell = rows["公式サイト"];

      // 証拠として原文をそのまま保持する(判定ロジックを疑えるように)
      const yoyakuRaw = hpbCell ? (hpbCell.href || hpbCell.text || "") : "";
      const koushikiRaw = officialCell ? (officialCell.href || officialCell.text || "") : "";

      const hpbUrl = hpbCell?.href && hpbCell.href.includes("hotpepper.jp") ? normalizeHpbUrl(hpbCell.href) : null;
      const officialUrl = officialCell?.href || null;
      const otherBookingUrl = !hpbUrl && hpbCell?.href ? hpbCell.href : null;

      let urlType, url, note;
      if (hpbUrl) {
        urlType = "hpb";
        url = hpbUrl;
        note = officialUrl ? `公式サイトも記載あり: ${officialUrl}` : "";
      } else if (officialUrl) {
        urlType = "official_site";
        url = officialUrl;
        note = otherBookingUrl ? `予約ページ(HPB以外): ${otherBookingUrl}` : "HPBに掲載なし。公式HPを正として使用";
      } else if (otherBookingUrl) {
        urlType = "other_booking_platform";
        url = otherBookingUrl;
        note = "★要確認: HPB/公式HPではなく別の予約プラットフォーム(楽天ビューティ/Airリザーブ/LINE予約等)のリンクのみ検出";
      } else {
        urlType = "not_found";
        url = "";
        note = "★要確認: テーブル内に予約ページ・公式サイトどちらのリンクも見つかりませんでした(表記: 予約ページ="
          + (yoyakuRaw || "空欄") + " / 公式サイト=" + (koushikiRaw || "空欄") + ")";
      }
      if (gi > 0) {
        note = `[見出しなし・同ブロック内の${gi + 1}店舗目として検出] ${note}`.trim();
      }

      results.push({
        articleUrl: post.link,
        heading: gi === 0 ? heading : storeName,
        storeName,
        urlType,
        url,
        address: rows["住所"]?.text || "",
        note,
        yoyakuRaw,
        koushikiRaw,
      });
    });
  });

  return results;
}

async function main() {
  console.log("記事取得中...");
  const posts = await fetchAllPosts();
  console.log(`記事件数: ${posts.length}`);

  let allStores = [];
  for (const post of posts) {
    allStores.push(...extractStoresFromPost(post));
  }
  console.log(`抽出した店舗候補(重複含む): ${allStores.length}`);

  // 重複排除: HPBのURLがあればそれをキーに、無ければ店舗名(記号除去)をキーにする
  const dedup = new Map();
  for (const s of allStores) {
    const key = s.urlType === "hpb" ? s.url : s.storeName.replace(/[【】\s　]/g, "");
    if (!dedup.has(key)) {
      dedup.set(key, { ...s, articleUrls: [s.articleUrl] });
    } else {
      const existing = dedup.get(key);
      if (!existing.articleUrls.includes(s.articleUrl)) existing.articleUrls.push(s.articleUrl);
      const rank = { hpb: 3, official_site: 2, other_booking_platform: 1, not_found: 0 };
      if (rank[s.urlType] > rank[existing.urlType]) {
        Object.assign(existing, s, { articleUrls: existing.articleUrls });
      }
    }
  }
  const unique = [...dedup.values()];
  const counts = unique.reduce((acc, s) => { acc[s.urlType] = (acc[s.urlType] || 0) + 1; return acc; }, {});
  console.log(`重複排除後の店舗数: ${unique.length}`);

  // 抽出した全URLの生存確認(HTTPステータス・「掲載期間終了」等の文言)を行う
  // 同時実行数を絞りつつ実行(HPB側への配慮)
  const targets = unique.filter((s) => s.url);
  console.log(`生存確認対象: ${targets.length}件 (これには数分かかります)`);
  const CONCURRENCY = 5;
  let idx = 0, done = 0;
  async function worker() {
    while (idx < targets.length) {
      const i = idx++;
      const s = targets[i];
      const check = await checkUrlAlive(s.url);
      s.liveCheck = check;
      done++;
      if (done % 100 === 0) console.log(`  生存確認進捗: ${done}/${targets.length}`);
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 生存確認結果に応じてurlTypeを補正
  for (const s of unique) {
    if (!s.url) { s.liveStatus = "n/a"; continue; }
    const c = s.liveCheck;
    if (!c) { s.liveStatus = "unchecked"; continue; }
    if (c.alive) {
      s.liveStatus = "live";
    } else if (c.expired) {
      s.liveStatus = "expired(掲載終了)";
      s.note = `${s.note} ★リンク切れ(掲載期間終了)を検知。要再調査`.trim();
    } else {
      s.liveStatus = `error(HTTP ${c.status})`;
      s.note = `${s.note} ★アクセス確認できず(HTTP ${c.status})。要再調査`.trim();
    }
  }
  const liveCounts = unique.reduce((acc, s) => { acc[s.liveStatus || "n/a"] = (acc[s.liveStatus || "n/a"] || 0) + 1; return acc; }, {});
  console.log("生存確認結果:", liveCounts);
  console.log("内訳:", counts);

  if (!SPREADSHEET_ID || !KEY_PATH) {
    console.log("SPREADSHEET_ID/KEY_PATH未設定のためシート書き込みはスキップします。");
    return;
  }

  const auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const sheets = google.sheets({ version: "v4", auth });

  const TAB_NAME = "店舗候補リスト";
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === TAB_NAME);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
    });
  }

  const header1 = ["店舗名", "URL種別", "生存確認", "URL", "住所(参考)", "備考", "予約ページ原文(証拠)", "公式サイト原文(証拠)", "掲載記事URL(複数可)"];
  const header2 = ["store_name", "url_type(hpb/official_site/other_booking_platform/not_found)", "live_status(live/expired/error/n_a)", "url", "address_ref", "note", "yoyaku_raw", "koushiki_raw", "article_urls"];
  const rows = unique
    .sort((a, b) => {
      // 要対応(expired/error/not_found)が上に来るように並べる
      const priority = (s) => {
        if (s.urlType === "not_found") return 0;
        if (s.liveStatus && s.liveStatus !== "live" && s.liveStatus !== "n/a") return 1;
        return 2;
      };
      return priority(a) - priority(b);
    })
    .map((s) => [s.storeName, s.urlType, s.liveStatus || "", s.url, s.address, s.note, s.yoyakuRaw, s.koushikiRaw, s.articleUrls.join(" / ")]);

  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${TAB_NAME}!A1:Z10000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [header1, header2, ...rows] },
  });

  const meta2 = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetId = meta2.data.sheets.find((s) => s.properties.title === TAB_NAME).properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
        { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2 }, cell: { userEnteredFormat: { textFormat: { fontSize: 8, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } } } }, fields: "userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor" } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } },
      ],
    },
  });

  console.log(`「${TAB_NAME}」タブに書き込みました。`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
