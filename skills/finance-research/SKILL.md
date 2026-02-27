---
name: Finance Research
description: Conduct analyst-grade financial research across primary and secondary markets using structured financial data plus macro and public-information cross-checks.
version: 1.1.1
metadata:
  emoji: "\U0001F4CA"
  tags:
    - finance
    - research
    - stocks
    - data
    - macro
    - sentiment
userInvocable: true
disableModelInvocation: false
---

## Instructions

You are conducting financial research with an analyst-grade standard. Tool usage is a dynamic decision. Do not force tool combinations. Choose tools based on evidence sufficiency for the specific question.

### Available Data Actions

#### Price Data
- `get_crypto_price_snapshot` — Current crypto price. Params: `{ ticker }` (e.g. "BTC-USD")
- `get_crypto_prices` — Historical crypto prices. Params: `{ ticker, start_date, end_date, interval?, interval_multiplier? }`
- `get_available_crypto_tickers` — List available crypto tickers. Params: `{}`

#### Financial Statements
All share params: `{ ticker, period, limit?, report_period_gt?, report_period_gte?, report_period_lt?, report_period_lte? }`
- period: "annual", "quarterly", or "ttm"
- Dates in YYYY-MM-DD format

Actions:
- `get_income_statements` — Revenue, expenses, net income, EPS
- `get_balance_sheets` — Assets, liabilities, equity, debt, cash
- `get_cash_flow_statements` — Operating, investing, financing cash flows, FCF
- `get_all_financial_statements` — All three at once (more efficient when you need multiple)

#### Metrics & Estimates
- `get_financial_metrics` — Historical metrics. Params: `{ ticker, period?, limit?, report_period*? }`
- `get_analyst_estimates` — EPS and revenue estimates. Params: `{ ticker, period? }`

#### Company Info
- `get_company_facts` — Sector, industry, employees, exchange, website. Params: `{ ticker }`
- `get_news` — Recent company news articles. Params: `{ ticker, start_date?, end_date?, limit? }`
- `get_insider_trades` — Insider buying/selling (SEC Form 4). Params: `{ ticker, limit?, filing_date*? }`
- `get_segmented_revenues` — Revenue by segment/geography. Params: `{ ticker, period, limit? }`

#### SEC Filings
- `get_filings` — List filings metadata. Params: `{ ticker, filing_type?, limit? }`
- `get_filing_items` — Read filing sections. Params: `{ ticker, filing_type, accession_number?, item? }`

### Evidence Sufficiency Gate (Internal Decision)

Before deep analysis, make an internal evidence decision. Do not output a technical decision block by default.

If the user explicitly asks for methodology or reasoning transparency, provide a concise plain-language explanation of your research approach.

Decision policy:

- Start with `data_only` when structured data can support the requested conclusion.
- Escalate to `hybrid` when the task is event-driven, time-sensitive, or requires causal explanation not visible in structured data alone.
- Use `web_first` only when the task is mainly document/news/policy driven (common in pre-IPO without stable ticker coverage).
- If a tool is unavailable, continue with available tools and explicitly downgrade confidence.

### Core Analysis Framework

1. **Scope & Market Type**
- Identify if this is primary market (IPO, pre-IPO, follow-on, placement) or secondary market (listed stock/sector/index).
- State region and analysis horizon (event-driven, 3-6 months, 1-3 years).

2. **Core Company Data (Structured)**
- Start with: `get_company_facts`, `get_financial_metrics`.
- Pull statements (`get_all_financial_statements`) and estimates as needed.

3. **Macro & Policy Context (Conditional)**
- Use `web_search` / `web_fetch` only if required by your internal evidence decision.
- If used, prefer high-signal primary sources (central bank, regulator, official releases).
- For time-sensitive conclusions, include source dates explicitly.

4. **News & Sentiment Context (Conditional)**
- Use `get_news` for company-linked coverage when available.
- Add web cross-checks only when event validation materially affects the conclusion.

5. **Synthesis & Decision**
- Separate **facts**, **inference**, and **assumptions**.
- Build bull/base/bear scenarios with explicit trigger conditions.
- Provide confidence level and explain the main uncertainty drivers.

### Primary Market (一级市场) Workflow

When asked about IPOs, pre-IPO, or new issuance:

1. **Deal Basics**
- Identify issuer, listing venue, offering structure (primary/secondary shares), expected timeline.
- Determine whether a reliable ticker exists in current data coverage.

2. **Filing/Prospectus Review**
- Prefer official documents (e.g., S-1/F-1/prospectus) via `web_search` + `web_fetch`.
- Extract: use of proceeds, customer concentration, related-party transactions, share classes, lock-up, dilution risks.

Primary-market capability boundary:
- If `ticker` is available and filings are retrievable, run hybrid analysis (structured + document evidence).
- If `ticker` is unavailable or structured filing fields are limited, run web-led analysis and clearly label it as partial-coverage with reduced confidence.

3. **Valuation & Comparable Set**
- Build peer set from listed comps (secondary market tickers) and compare growth, margin, and valuation multiples.
- Flag gaps between issuer narrative and peer reality.

4. **Deal Risk Map**
- Highlight red flags: weak FCF quality, aggressive non-GAAP adjustments, concentrated revenue, regulatory overhang.
- Provide post-listing watch items: lock-up expiry, first earnings, guidance revisions.

### Secondary Market (二级市场) Workflow

When asked about listed equities:

1. **Trend & Positioning**
- Pull 1y price history (`get_crypto_prices` for crypto, or use `web_search` for stock prices) and identify regime (uptrend/range/downtrend) with volatility context.

2. **Fundamentals**
- Analyze growth quality (revenue vs FCF), margin durability, leverage, and capital allocation.

3. **Valuation**
- Compare current multiples to historical bands and peers (when peer data is available).
- Connect valuation premium/discount to expected growth and risk profile.

4. **Catalysts & Risks**
- Earnings, guidance, product cycle, policy changes, rates/FX/commodity sensitivity, insider activity.

### Output Standard

Always include:

1. **Executive Summary** (thesis + stance + confidence)
2. **Evidence Table** with columns:
- Signal
- Direction (Bull/Bear/Neutral)
- Why it matters
- Source
- Date
3. **Scenario Table** (bull/base/bear with probabilities or relative weights)
4. **Key Monitoring Triggers** (what would invalidate current thesis)

### Guardrails

- Always state data cutoff dates.
- If data is missing, explicitly mark it and show the impact on confidence.
- Do not present assumptions as facts.
- For event-driven conclusions, if you skip web validation, explicitly explain why structured evidence is still sufficient.


### Example: Secondary Market Analysis

For "Analyze Apple's investment outlook":

1. `data(domain="finance", action="get_company_facts", params={ticker: "AAPL"})`
3. `data(domain="finance", action="get_all_financial_statements", params={ticker: "AAPL", period: "annual", limit: 3})`
4. `data(domain="finance", action="get_financial_metrics", params={ticker: "AAPL", period: "quarterly", limit: 8})`
5. `data(domain="finance", action="get_analyst_estimates", params={ticker: "AAPL", period: "annual"})`
6. `data(domain="finance", action="get_news", params={ticker: "AAPL", limit: 10})`
7. `web_search(query="latest Fed policy decision impact on US mega-cap tech valuations")`
8. `web_search(query="Apple supply chain or regulatory news latest quarter")`

Then synthesize fundamental trend, macro regime, and event sentiment into a scenario-based conclusion.
