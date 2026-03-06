# Web Search

Mercury agents can search the web and fetch content from URLs using `agent-browser`, a headless browser CLI. No API keys required.

## How It Works

```
User asks a question requiring current information
  │
  ├─► Agent reads AGENTS.md instructions
  │
  ├─► Opens headless browser with Chrome user-agent
  │     • Brave Search: https://search.brave.com/search?q=...
  │     • Returns rich results (titles, URLs, snippets)
  │
  ├─► Extracts text content
  │     • agent-browser get text body
  │
  └─► Summarizes and responds to user
```

## Why Browser-Based Search?

| Approach | Pros | Cons |
|----------|------|------|
| **Browser (agent-browser)** | Free, no API key, full page content | Slower, larger container |
| Tavily API | Fast, AI-optimized | $0.008/search, requires key |
| Serper API | Fast, cheap | $0.001/search, requires key |
| Google/Bing direct | — | Blocked with CAPTCHAs |

Mercury uses browser-based search by default for zero-config operation.

## Search Engines

| Engine | Status | Notes |
|--------|--------|-------|
| **Brave Search** | ✅ Works | Recommended. Rich results, no CAPTCHA |
| **Startpage** | ✅ Works | Google-powered results, fallback option |
| Google | ❌ Blocked | Always shows CAPTCHA |
| DuckDuckGo | ❌ Blocked | Returns 418 error |
| Bing | ❌ Blocked | Requires human verification |

## User-Agent Requirement

**Critical:** A Chrome user-agent header is required to avoid CAPTCHAs.

```bash
# Without user-agent: CAPTCHA
agent-browser open "https://search.brave.com/search?q=test"
# → Blocked or degraded results

# With user-agent: Works
agent-browser --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  open "https://search.brave.com/search?q=test"
# → Full search results
```

## Container Setup

The Dockerfile installs Chromium dependencies and `agent-browser`:

```dockerfile
# Install Chromium dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxdamage1 libxfixes3 libxi6 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnspr4 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser
RUN bun add -g agent-browser

# Install Chromium browser
RUN bunx playwright install chromium
```

This adds ~300MB to the container image.

## Agent Instructions

The agent receives these instructions via `.mercury/global/AGENTS.md`:

```markdown
## Web Search

Use `agent-browser` with Brave Search. **Always include the user-agent to avoid CAPTCHAs:**

\`\`\`bash
agent-browser close 2>/dev/null
agent-browser --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  open "https://search.brave.com/search?q=your+query+here"
agent-browser get text body
\`\`\`

To fetch content from a URL:

\`\`\`bash
agent-browser open "https://example.com"
agent-browser wait --load networkidle
agent-browser get text body
\`\`\`
```

## Examples

### Search the Web

```bash
# 1. Close any existing browser session
agent-browser close 2>/dev/null

# 2. Open Brave Search with user-agent
agent-browser --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  open "https://search.brave.com/search?q=typescript+5.0+new+features"

# 3. Extract results
agent-browser get text body
```

### Fetch URL Content

```bash
# Navigate to page
agent-browser open "https://docs.python.org/3/tutorial/"

# Wait for JavaScript to load
agent-browser wait --load networkidle

# Get text content
agent-browser get text body
```

### Search Then Visit Result

```bash
# Search
agent-browser --user-agent "..." \
  open "https://search.brave.com/search?q=bun+runtime+documentation"
agent-browser get text body

# Visit a result (URL from search results)
agent-browser open "https://bun.sh/docs"
agent-browser wait --load networkidle
agent-browser get text body
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| CAPTCHA or blocked | Ensure `--user-agent` flag is set |
| Empty content | Use `agent-browser wait --load networkidle` before getting text |
| Missing results | Try `agent-browser scroll down 1000` then get text again |
| Browser not closing | Run `agent-browser close` before opening new session |
| "Executable doesn't exist" | Chromium not installed — rebuild container |

## Limitations

- **Speed:** Browser startup adds ~2-3 seconds per search
- **Container size:** Chromium adds ~300MB to the image
- **Rate limiting:** Search engines may rate limit heavy usage
- **JavaScript-heavy sites:** Some sites may not render fully in headless mode

## Alternative: Paid Search APIs

For production workloads with high volume, consider paid search APIs:

```bash
# Tavily (best for AI, $0.008/search)
export TAVILY_API_KEY=tvly-xxx

# Serper (cheapest, $0.001/search)  
export SERPER_API_KEY=xxx
```

These would require custom tools/extensions (not included by default).

## See Also

- [container-lifecycle.md](./container-lifecycle.md) — Container timeouts
- [pipeline.md](./pipeline.md) — Message routing
- [agent-browser docs](https://github.com/vercel-labs/agent-browser) — Full CLI reference
