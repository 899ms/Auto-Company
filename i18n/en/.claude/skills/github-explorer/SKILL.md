---
name: github-explorer
description: >
  Deep-dive analysis of GitHub projects. Use when the user mentions a GitHub repo/project name
  and wants to understand it — triggered by phrases like "help me look at this project", "learn about XXX",
  "what is this project like", "analyze this repo", or any request to explore/evaluate a GitHub project.
  Covers architecture, community health, competitive landscape, and cross-platform knowledge sources.
---

# GitHub Explorer — In-Depth Project Analysis

> **Philosophy**: The README is only the storefront; the real value lies in Issues, Commits, and community discussions.

## Workflow

```
[Project name] → [1. Locate Repo] → [2. Gather Multiple Sources] → [3. Analyze and Assess] → [4. Structured Output]
```

### Phase 1: Locate Repo

- Use `web_search` to search `site:github.com <project_name>` and confirm the full org/repo
- Use `search-layer` (Deep mode + intent awareness) to find additional community links and non-GitHub resources:
  ```bash
  python3 skills/search-layer/scripts/search.py \
    --queries "<project_name> review" "<project_name> 评测 使用体验" \
    --mode deep --intent exploratory --num 5
  ```
- Use `web_fetch` to fetch the repo homepage for basic information (README, Stars, Forks, License, last update)

### Phase 2: Gather Multiple Sources (In Parallel)

Check the following sources **as needed**; collect what exists and skip what does not:

| Source | URL pattern | What to collect | Suggested tool |
|---|---|---|---|
| GitHub Repo | `github.com/{org}/{repo}` | README, About, Contributors | `web_fetch` |
| GitHub Issues | `github.com/{org}/{repo}/issues?q=sort:comments` | Top 3-5 high-quality Issues | `browser` |
| Chinese-language communities | WeChat / Zhihu / Xiaohongshu | In-depth reviews, usage experiences | `content-extract` |
| Technical blogs | Medium / Dev.to | Technical architecture analyses | `web_fetch` / `content-extract` |
| Discussion forums | V2EX / Reddit | User feedback, complaints | `search-layer` (Deep mode) |

#### search-layer Usage Conventions

search-layer v2 supports intent-aware scoring. Recommended usage for github-explorer:

| Scenario | Command | Notes |
|------|------|------|
| **Project research (default)** | `python3 skills/search-layer/scripts/search.py --queries "<project> review" "<project> 评测" --mode deep --intent exploratory --num 5` | Run multiple queries in parallel; rank by authority |
| **Latest developments** | `python3 skills/search-layer/scripts/search.py "<project> latest release" --mode deep --intent status --freshness pw --num 5` | Prioritize freshness; filter to the past week |
| **Competitor comparison** | `python3 skills/search-layer/scripts/search.py --queries "<project> vs <competitor>" "<project> alternatives" --mode deep --intent comparison --num 5` | Comparison intent; weight both keywords and authority |
| **Quick link lookup** | `python3 skills/search-layer/scripts/search.py "<project> official docs" --mode fast --intent resource --num 3` | Exact matching; fastest |
| **Community discussion** | `python3 skills/search-layer/scripts/search.py "<project> discussion experience" --mode deep --intent exploratory --domain-boost reddit.com,news.ycombinator.com --num 5` | Boost community sites |

**Intent quick reference**: `factual` (facts) / `status` (updates) / `comparison` (comparisons) / `tutorial` (tutorials) / `exploratory` (exploration) / `news` (news) / `resource` (resource discovery)

> Without `--intent`, behavior is exactly the same as v1: no scoring, with results returned in their original order.

Fallback rules: if either Exa or Tavily returns 429/5xx, continue with the remaining sources; if the entire script fails, fall back to `web_search` as the sole source.

---

### Extraction Fallback and Upgrade Protocol (Extraction Upgrade)

You **must** upgrade from `web_fetch` to `content-extract` in any of these situations:
1. **Restricted domains**: `mp.weixin.qq.com`, `zhihu.com`, `xiaohongshu.com`.
2. **Complex structure**: The page contains many formulas (LaTeX), complex tables, or extremely messy Markdown returned by `web_fetch`.
3. **Missing content**: Anti-scraping defenses cause `web_fetch` to return empty content or a challenge page.

Invocation:
```bash
python3 skills/content-extract/scripts/content_extract.py --url <URL>
```

Internally, content-extract:
- Checks the domain allowlist first (WeChat, Zhihu, etc.); a match goes directly to MinerU
- Otherwise probes with `web_fetch` first and falls back to MinerU-HTML on failure
- Returns a unified JSON contract, including fields such as `ok`, `markdown`, and `sources`

### Phase 3: Analyze and Assess

Make judgments based on the collected data:

- **Project stage**: Early experiment / rapid growth / mature and stable / maintenance mode / stalled, based on commit frequency and content
- **Featured Issue criteria**: Many comments, maintainer participation, exposure of architectural problems, or valuable technical discussion
- **Competitor identification**: Extract from README "Comparison"/"Alternatives" sections, Issues discussions, and web searches

### Phase 4: Structured Output

Follow the template below strictly. **Every section must contain substantive content or explicitly say "Not found."**

#### Formatting Rules (Mandatory)

1. **The title must link to the GitHub repository** (format: `# [Project Name](https://github.com/org/repo)`, ensuring it is clickable)
2. **Put a blank line both before and after every heading** (end of previous section → blank line → heading → blank line → content, for clear visual separation)
3. **Telegram blank-line fix (mandatory)**: Telegram swallows blank lines after list items (lines starting with `-`). To fix this, insert a line containing a braille blank `⠀` (U+2800) between the end of the list and the next heading, as follows:
   ```
   - Last list item

   ⠀
   **Next heading**
   ```
   This ensures Telegram preserves the blank line before the heading when rendering.
2. **Make all headings bold** (emoji + bold text)
3. **Competitor comparisons must include links** (at least one of GitHub / official website / documentation)
4. **Community discussion must be specific**: Summarize concrete posts, tweets, or discussions and link to the originals. Do not write generalities such as "highly rated" or "very popular"; state who said what or which specific problem a post discussed
5. **Source traceability**: All external information cited should include the original link so readers can trace it to the source

```markdown
# [{Project Name}]({GitHub Repo URL})

**🎯 One-Sentence Positioning**

{What it is and what problem it solves}

**⚙️ Core Mechanism**

{Explain the technical principles / architecture in plain language, without copying the README. Include the key technology stack.}

**📊 Project Health**

- **Stars**: {Count}  |  **Forks**: {Count}  |  **License**: {Type}
- **Team / Author**: {Background}
- **Commit trend**: {Recent activity + assessment of project stage}
- **Latest developments**: {Summary of the latest important commits}

**🔥 Featured Issues**

{Top 3-5 high-quality Issues, each with a title, link, and key discussion points. State explicitly if there are no high-quality Issues.}

**✅ Suitable Use Cases**

{When to use it and which specific problems it solves}

**⚠️ Limitations**

{When to avoid it; known problems}

**🆚 Competitor Comparison**

{Compare projects in the same space and their differences. Every competitor must have a GitHub or official website link. Example format:}
- **vs [GraphRAG](https://github.com/microsoft/graphrag)** — Description of differences
- **vs [RAGFlow](https://github.com/infiniflow/ragflow)** — Description of differences

**🌐 Knowledge Graph**

- **DeepWiki**: {Link or "Not indexed"}
- **Zread.ai**: {Link or "Not indexed"}

**🎬 Demo**

{Live demo link or "None"}

**📄 Related Papers**

{arXiv link or "None"}

**📰 Community Discussion**

**X/Twitter**

{Summaries of specific tweets + links. Example format:}
- [@user](link): "What they specifically said..."
- [Discussion thread](link): The specific problem discussed...
{If nothing is found, state "No relevant discussion found"}

**Chinese-Language Communities**

{Specific post titles / content summaries + links. Example format:}
- [Zhihu: Post title](link) — What was discussed
- [V2EX: Post title](link) — What was discussed
{If nothing is found, state "No relevant discussion found"}

**💬 My Assessment**

{Subjective evaluation: whether it is worth the time, what experience level it suits, and how to use it}
```

## Execution Notes

- Prefer `web_search` + `web_fetch`, with browser as a fallback
- **Search enhancement**: For project research, use `search-layer` v2 Deep mode + `--intent exploratory` by default (Brave + Exa + Tavily queried in parallel, with deduplication and intent-aware scoring); one source failing must not block the main workflow
- **Extraction fallback (mandatory)**: If `web_fetch` fails, returns 403, an anti-scraping page, or an overly short body, or the source is on a high-risk domain such as WeChat, Zhihu, or Xiaohongshu, switch to `content-extract` (which falls back internally to MinerU-HTML) to obtain cleaner Markdown and traceable sources
- Collect different sources in parallel for efficiency
- All links must be real and accessible; do not invent URLs
- Output in English; keep technical terms in English

## ⚠️ Output Self-Check (Mandatory Before Every Response)

Before sending a report, you **must check every item below**, and send it only when all pass:

- [ ] **Title link**: Uses `# [Project Name](GitHub URL)` and is clickable
- [ ] **Heading spacing**: A blank line before and after every bold heading (`**🎯 ...**`)
- [ ] **Telegram blank lines**: A braille blank `⠀` line between the end of each list block and the next heading, preventing Telegram from swallowing blank lines
- [ ] **Issue links**: Every featured Issue uses the full `[#number Title](full URL)` format
- [ ] **Competitor links**: Every competitor has `[Name](GitHub / official website URL)`
- [ ] **Community discussion links**: Every citation uses `[Source: Title](URL)`
- [ ] **No vague descriptions**: The community section contains no generalities such as "highly rated" or "very popular"
- [ ] **Source traceability**: All external citations include original links

## Dependencies

This skill depends on the following OpenClaw tools and skills:

| Dependency | Type | Purpose |
|------|------|------|
| `web_search` | Built-in tool | Brave Search queries |
| `web_fetch` | Built-in tool | Web content retrieval |
| `browser` | Built-in tool | Dynamic page rendering (fallback) |
| `search-layer` | Skill | Multi-source search + intent-aware scoring (Brave + Exa + Tavily); v2 supports `--intent` / `--queries` / `--freshness` |
| `content-extract` | Skill | High-fidelity content extraction (fallback for anti-scraping sites) |
