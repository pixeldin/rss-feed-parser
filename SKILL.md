---
name: rss-feed-parser
version: 1.0.0
description: 解析RSS订阅源，提取文章标题、链接、发布时间。支持本地XML文件、目录批量解析、在线RSS链接，可按时间范围和关键词过滤。当用户需要读取RSS订阅、抓取RSS文章列表时使用此skill。
---

# RSS 订阅解析器

## 使用场景

- 用户说"解析这些RSS订阅"或"抓取RSS文章"
- 用户提供RSS订阅链接（XML格式）
- 用户想从本地RSS文件中提取文章列表
- 用户需要按时间或关键词过滤RSS文章

## 前置依赖

脚本依赖 `fast-xml-parser`，首次使用前需在 skill 的 `scripts` 目录下安装：

```bash
cd <skill_root>/scripts && npm install
```

## 操作步骤

1. 确定用户提供的RSS来源（本地文件/目录路径 或 在线URL）
2. 使用 `exec` 工具运行脚本解析RSS
3. 将解析结果返回给用户

## 命令格式

```bash
node <skill_root>/scripts/parse_rss.js <source> [options]
```

### 参数说明

- `<source>`（必填）：RSS来源，可以是：
  - 本地XML文件路径：`./feeds/example.xml`
  - 包含XML文件的目录：`./feeds/`
  - 在线RSS链接：`https://example.com/rss.xml`
- `--since YYYY-MM-DD`：只保留该日期之后的文章
- `--until YYYY-MM-DD`：只保留该日期之前的文章
- `--keywords 词1,词2`：按标题关键词过滤，匹配任一即保留
- `--output filename.json`：自定义输出文件名

### 使用示例

解析本地目录下所有RSS文件：
```bash
node scripts/parse_rss.js ./src-link
```

解析在线RSS并按时间过滤：
```bash
node scripts/parse_rss.js "https://example.com/feed.xml" --since 2026-03-01
```

同时按时间和关键词过滤：
```bash
node scripts/parse_rss.js ./src-link --since 2026-03-01 --keywords FPSO,海工
```

## 输出格式

脚本输出JSON，包含文章数组，每篇文章包括：
- `title`：文章标题
- `link`：原文链接
- `pubDate`：发布时间
- `source`：来源标识

结果文件默认保存为 `result_since_<日期>.json`。

## 注意事项

- 支持标准RSS 2.0格式，兼容CDATA包裹的字段
- 在线RSS需要目标服务器允许HTTP访问，支持自动重定向
- 结果按发布时间降序排列
- 如果脚本返回空结果，可能是RSS源格式不标准或网络不通
