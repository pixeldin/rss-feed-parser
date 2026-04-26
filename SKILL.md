---
name: rss-feed-parser
version: 1.3.0
description: 解析RSS订阅源，提取文章标题、链接、发布时间。支持本地XML文件、目录批量解析、在线RSS链接，支持同时传入多个源并合并为一个结果文件，支持为每个源指定别名，可按时间范围、正向/反向关键词和文章字数过滤。支持通过 --target 指定主题进行正向关键词匹配，仅保留与主题相关的文章。当用户需要读取RSS订阅、抓取RSS文章列表时使用此skill。
---

# RSS 订阅解析器

## 重要规则

1. **禁止使用 `web_fetch` 或 `web_search`**。脚本内置了HTTP请求能力，会自己获取在线RSS内容。
2. **必须且只能通过 `exec` 工具**运行 `node <skill_root>/scripts/parse_rss.js` 来完成所有操作。
3. **URL必须原样传递，不得修改**。RSS链接中的 `=` 号（如Base64 padding `====`）是链接的一部分，不能删除、截断或转义。将完整URL用双引号包裹传入即可。

## 使用场景

- 用户说"解析这些RSS订阅"或"抓取RSS文章"
- 用户提供一个或多个RSS订阅链接
- 用户想从本地RSS文件中提取文章列表
- 用户需要按时间或关键词过滤RSS文章

## 前置依赖

首次使用前需在 skill 的 `scripts` 目录下安装依赖：

```bash
cd <skill_root>/scripts && npm install
```

## 命令格式

```bash
node <skill_root>/scripts/parse_rss.js <source1> [source2 ...] [options]
```

## source 参数

每个 source 可以是以下任意一种：

- 在线RSS链接：`"http://example.com/rss.xml"`（必须用双引号包裹）
- 本地XML文件：`./feeds/example.xml`
- 包含XML文件的目录：`./feeds/`
- 带别名的源（用 `@@` 分隔）：`"别名@@http://地址"`

### 别名语法

在源地址前加 `别名@@` 可以自定义该源在结果中的 source 字段名称：

```bash
node scripts/parse_rss.js "中国海油@@http://rss.example.com/feed1.xml" "中国船舶@@http://rss.example.com/feed2.xml"
```

不指定别名时，在线源自动使用RSS频道标题，本地文件使用文件名。

### 多源合并

传入多个 source 时，所有源的文章会合并到同一个结果JSON文件中，按发布时间降序排列，每篇文章通过 source 字段区分来源。

## 可选参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `--since YYYY-MM-DD` | 只保留该日期之后的文章 | `--since 2026-03-01` |
| `--until YYYY-MM-DD` | 只保留该日期之前的文章 | `--until 2026-04-01` |
| `--target 主题名` | 按主题正向筛选，仅保留命中主题关键词的文章 | `--target 海洋油气装备` |
| `--keywords kw1,kw2` | 正向关键词标记，正文匹配任一则标记 `keywordMatched: true` 并优先排序，不命中不排除 | `--keywords FPSO,海工` |
| `--exclude kw1,kw2` | 反向关键词过滤，正文匹配任一即排除 | `--exclude 招聘,广告` |
| `--min-length N` | 文章正文字数低于N则跳过 | `--min-length 300` |
| `--output file.json` | 自定义输出文件名 | `--output my_result.json` |

不指定 `--output` 时，默认文件名为 `result_since_<日期>.json`（有 --since 时）或 `result_since_all.json`。

## 规则文件

规则文件统一存放在 `rules/` 目录下：

```
rss-parser/
  rules/
    filter_rules.json    # 反向排除规则
    target_rules.json    # 主题正向匹配规则
```

### filter_rules.json — 反向排除规则

始终生效，用于排除不相关的文章。包含两个字段：

- `excludeTitle`：标题中包含任一关键词的文章将被排除
- `excludeContent`：正文中包含任一关键词的文章将被排除

```json
{
  "excludeTitle": ["招聘", "广告", "股市"],
  "excludeContent": ["招聘信息", "广告推广"]
}
```

### target_rules.json — 主题正向匹配规则

通过 `--target 主题名` 启用。文件结构为按主题分组的关键词集合：

```json
{
  "topics": {
    "海洋油气装备": {
      "description": "海洋油气装备国内外合作资讯",
      "includeTitle": ["海洋油气装备", "FPSO", "海工装备", "..."],
      "includeContent": ["海洋油气装备", "offshore oil and gas equipment", "..."]
    },
    "海洋碳产业": {
      "description": "海洋碳产业交易机制",
      "includeTitle": ["蓝碳", "碳交易", "海洋碳汇", "..."],
      "includeContent": ["blue carbon", "碳交易", "marine carbon sink", "..."]
    }
  }
}
```

每个主题包含：

- `description`：主题描述
- `includeTitle`：标题正向匹配关键词列表
- `includeContent`：正文正向匹配关键词列表（支持中英文）

新增主题只需在 `topics` 下添加新的键，脚本无需修改。

### 过滤执行顺序

指定 `--target` 时，完整的过滤流程按以下顺序执行：

1. 日期范围过滤（`--since` / `--until`）
2. `filter_rules.json` 反向排除（标题/正文命中排除词 → 排除）
3. `target_rules.json` 正向匹配（标题或正文必须命中至少一个主题关键词，否则排除）
4. `--keywords` 标记（命中打标记用于优先排序，不排除）
5. `--exclude` 排除
6. `--min-length` 最小字数过滤

`--target` 是强过滤，未命中主题关键词的文章会被直接排除。命中的文章会附带 `targetMatched: true` 和 `matchedKeywords` 字段。

## 使用示例

解析单个在线RSS（注意双引号包裹完整URL）：
```bash
node scripts/parse_rss.js "http://rss.example.com/rss/ABCDEFG===="
```

多个在线RSS带别名，合并输出：
```bash
node scripts/parse_rss.js "海油@@http://rss.example.com/feed1.xml" "船舶@@http://rss.example.com/feed2.xml" --since 2026-04-01
```

解析本地目录：
```bash
node scripts/parse_rss.js ./src-link
```

混合使用在线和本地源：
```bash
node scripts/parse_rss.js "海油@@http://rss.example.com/feed.xml" ./src-link --keywords 海工,FPSO
```

按主题正向筛选（仅保留海洋油气装备相关文章）：
```bash
node scripts/parse_rss.js ./src-link --since 2026-04-01 --target 海洋油气装备
```

主题筛选 + 关键词标记组合使用：
```bash
node scripts/parse_rss.js ./src-link --target 海洋碳产业 --keywords 蓝碳,CCER --since 2026-04-01
```

## 输出格式

脚本输出JSON到stdout，同时写入结果文件。结构如下：

```json
{
  "ok": true,
  "total": 16,
  "filtered": 7,
  "target": "海洋油气装备",
  "outputFile": "/path/to/result_since_20260401.json",
  "articles": [
    {
      "title": "文章标题",
      "link": "http://原文链接",
      "pubDate": "Wed, 01 Apr 2026 21:19:00 +0800",
      "source": "中国海油",
      "targetMatched": true,
      "matchedKeywords": ["FPSO", "海工装备"]
    }
  ]
}
```

## 注意事项

- 禁止使用 `web_fetch` 获取RSS内容，脚本自己会发HTTP请求
- URL中的特殊字符（如末尾的 `====`）是有效内容，不要修改或删除
- `--until` 的日期解析为当天零点，如需包含当天文章请用次日日期
- 如果脚本返回空结果，可能是所有文章都被时间过滤掉了
