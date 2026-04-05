#!/usr/bin/env node
/**
 * RSS 订阅解析脚本 — OpenClaw Skill 入口
 *
 * 用法:
 *   node parse_rss.js <source> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                               [--keywords kw1,kw2] [--output file.json]
 *
 * <source> 可以是本地XML文件、目录、或在线RSS链接(http/https)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { XMLParser } = require("fast-xml-parser");

// ============ RSS 解析 ============

function unwrapCdata(val) {
  if (val && typeof val === "object" && val.__cdata !== undefined) {
    return String(val.__cdata).trim();
  }
  return val != null ? String(val).trim() : "";
}

function parseRSS(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: "__cdata",
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map((item) => ({
    title: unwrapCdata(item.title),
    link: unwrapCdata(item.link),
    pubDate: unwrapCdata(item.pubDate),
  }));
}

// ============ 过滤 ============

function filterArticles(articles, opts = {}) {
  return articles.filter((a) => {
    if (opts.since || opts.until) {
      const t = new Date(a.pubDate).getTime();
      if (isNaN(t)) return false;
      if (opts.since && t < new Date(opts.since).getTime()) return false;
      if (opts.until && t > new Date(opts.until).getTime()) return false;
    }
    if (opts.keywords && opts.keywords.length > 0) {
      const lower = a.title.toLowerCase();
      if (!opts.keywords.some((kw) => lower.includes(kw.toLowerCase()))) return false;
    }
    return true;
  });
}

// ============ HTTP 获取 ============

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, { headers: { "User-Agent": "OpenClaw-RSS-Parser/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

// ============ 主流程 ============

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const usage = {
      ok: false,
      error: "用法: node parse_rss.js <source> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--keywords kw1,kw2] [--output file.json]",
    };
    console.log(JSON.stringify(usage, null, 2));
    process.exit(2);
  }

  const source = args[0];
  let since, until, keywords, output;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) since = args[++i];
    else if (args[i] === "--until" && args[i + 1]) until = args[++i];
    else if (args[i] === "--keywords" && args[i + 1]) keywords = args[++i].split(",");
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
  }

  try {
    let allArticles = [];

    if (source.startsWith("http://") || source.startsWith("https://")) {
      // 在线 RSS
      const xml = await fetchUrl(source);
      const articles = parseRSS(xml);
      const hostname = new URL(source).hostname.replace(/\./g, "_");
      articles.forEach((a) => (a.source = hostname));
      allArticles.push(...articles);
    } else {
      // 本地文件或目录
      const absPath = path.resolve(source);
      if (!fs.existsSync(absPath)) throw new Error(`路径不存在：${absPath}`);

      const files = [];
      if (fs.statSync(absPath).isDirectory()) {
        fs.readdirSync(absPath)
          .filter((f) => f.endsWith(".xml"))
          .forEach((f) => files.push(path.join(absPath, f)));
      } else {
        files.push(absPath);
      }
      if (files.length === 0) throw new Error("目录中未找到任何 .xml 文件");

      for (const file of files) {
        const xml = fs.readFileSync(file, "utf-8");
        const articles = parseRSS(xml);
        articles.forEach((a) => (a.source = path.basename(file, ".xml")));
        allArticles.push(...articles);
      }
    }

    const totalCount = allArticles.length;

    // 过滤
    if (since || until || (keywords && keywords.length > 0)) {
      allArticles = filterArticles(allArticles, { since, until, keywords });
    }

    // 按发布时间降序
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // 写入结果文件
    const sinceTag = since ? since.replace(/-/g, "") : "all";
    const outputFile = output || `result_since_${sinceTag}.json`;
    const outputDir = source.startsWith("http") ? process.cwd() : path.dirname(path.resolve(source));
    const outputPath = path.resolve(outputDir, outputFile);
    fs.writeFileSync(outputPath, JSON.stringify(allArticles, null, 2), "utf-8");

    // 输出结构化结果供 OpenClaw 读取
    const result = {
      ok: true,
      total: totalCount,
      filtered: allArticles.length,
      outputFile: outputPath,
      articles: allArticles,
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
