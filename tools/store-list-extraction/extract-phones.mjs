// 406記事から店舗名+電話番号を再抽出し、シートのA列(店舗名)に対応する電話番号マップを作る
import * as cheerio from "cheerio";
import fs from "fs";

const WP_BASE = "https://eyebrow-navi.com";

function norm(s) {
  return (s || "")
    .replace(/[【】\[\]（）()]/g, "")
    .replace(/\s|　/g, "")
    .toLowerCase();
}

async function fetchAllPosts() {
  const posts = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${WP_BASE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,link,content`);
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

function parseTableGroups($, blockHtml) {
  const $$ = cheerio.load(`<div>${blockHtml}</div>`);
  const groups = [];
  let current = null;
  $$("table tr").each((_, tr) => {
    const tds = $$(tr).find("td");
    if (tds.length < 2) return;
    const label = $$(tds[0]).text().trim();
    const val = $$(tds[1]).text().trim();
    if (label === "店舗名") {
      current = {};
      groups.push(current);
    }
    if (!current) { current = {}; groups.push(current); }
    current[label] = val;
  });
  return groups;
}

async function main() {
  const posts = await fetchAllPosts();
  console.log("記事件数:", posts.length);

  const phoneMap = {}; // normalizedName -> phone
  posts.forEach((post) => {
    const $ = cheerio.load(post.content.rendered);
    $("h3").each((_, el) => {
      const $el = $(el);
      let html = "";
      let sib = $el.next();
      while (sib.length && !["h2", "h3", "h4"].includes(sib.prop("tagName")?.toLowerCase())) {
        html += $.html(sib);
        sib = sib.next();
      }
      const groups = parseTableGroups($, html);
      groups.forEach((rows) => {
        const name = rows["店舗名"];
        const tel = rows["電話番号"];
        if (!name || !tel) return;
        const key = norm(name);
        if (!phoneMap[key]) phoneMap[key] = tel;
      });
    });
  });

  const count = Object.keys(phoneMap).length;
  console.log("電話番号を抽出できた店舗数:", count);
  fs.writeFileSync("phone-map.json", JSON.stringify(phoneMap, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
