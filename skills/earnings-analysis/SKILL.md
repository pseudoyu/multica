---
name: Earnings Analysis
description: >-
  Analyze a company's financial statements (income statement, balance sheet,
  cash flow statement) to assess financial health, earnings quality, and
  competitive advantage. Use when the user asks to read/analyze financial
  statements, check earnings quality, assess financial health, evaluate
  profitability trends, or screen for competitive moats.
version: 1.0.0
metadata:
  emoji: "\U0001F4D1"
  requires:
    env:
      - FINANCIAL_DATASETS_API_KEY
  tags:
    - finance
    - earnings
    - analysis
    - statements
    - buffett
userInvocable: true
disableModelInvocation: false
---

## Instructions

You are performing a structured financial statement analysis. Follow all steps in order and show your work. Output language must match the user's input language.

**IMPORTANT: This analysis requires BOTH structured data AND external context.** You MUST use `web_search` to gather earnings call insights, industry context, and explanations for data anomalies. An analysis based only on API data without any web research is incomplete. Expect to make 3-6 web searches throughout the analysis.

### Progress Checklist

```
Earnings Analysis Progress:
- [ ] Step 1: Gather financial data
- [ ] Step 2: Income statement analysis
- [ ] Step 3: Balance sheet analysis
- [ ] Step 4: Cash flow statement analysis
- [ ] Step 5: Buffett competitive advantage scoring
- [ ] Step 6: Quality of earnings assessment
- [ ] Step 7: SEC filing qualitative analysis
- [ ] Step 8: Peer comparison (if requested)
- [ ] Step 9: Present findings
```

### Step 1: Gather Financial Data

Use `data` tool with `domain="finance"` for all structured data calls.

#### 1a. Structured Data

1. **Annual financial statements** (5 years):
   ```
   action: "get_all_financial_statements"
   params: { ticker: "[TICKER]", period: "annual", limit: 5 }
   ```
   This returns income statements, balance sheets, and cash flow statements together.

2. **Quarterly financial statements** (last 4 quarters):
   ```
   action: "get_all_financial_statements"
   params: { ticker: "[TICKER]", period: "quarterly", limit: 4 }
   ```

3. **Current financial metrics**:
   ```
   action: "get_financial_metrics"
   params: { ticker: "[TICKER]", period: "quarterly", limit: 1 }
   ```

4. **Company facts**:
   ```
   action: "get_company_facts"
   params: { ticker: "[TICKER]" }
   ```
   Extract: `sector`, `industry` — needed for benchmark comparisons in later steps.

5. **Recent news**:
   ```
   action: "get_news"
   params: { ticker: "[TICKER]", limit: 10 }
   ```
   Scan headlines for material events (earnings surprises, guidance changes, M&A, restructuring).

#### 1b. External Context (Web Search) — MANDATORY

You MUST run the following two web searches after gathering structured data. These are not optional.

1. **Latest earnings call highlights** (REQUIRED):
   ```
   web_search("[COMPANY] latest earnings call highlights key takeaways [CURRENT_YEAR]")
   ```
   Extract: management guidance, segment commentary, strategic priorities, forward outlook.
   This provides the "why" behind the numbers that structured data cannot explain.

2. **Industry/macro backdrop** (REQUIRED):
   ```
   web_search("[INDUSTRY] industry outlook trends [CURRENT_YEAR]")
   ```
   Extract: industry growth rate, tailwinds/headwinds, regulatory changes, competitive dynamics.
   This is needed to assess whether the company's performance is company-specific or industry-wide.

3. **Company-specific events** (conditional — run if news headlines or data show a material event):
   ```
   web_search("[COMPANY] [EVENT_KEYWORD] impact analysis")
   ```
   Examples: acquisition, restructuring, product launch, lawsuit, management change.

**Checkpoint:** Before proceeding to Step 2, verify that you have completed at least 2 web searches above. If you have not, go back and run them now.

### Step 2: Income Statement Analysis

Analyze the income statement across all 5 annual periods. Calculate and present:

1. **Revenue trend**:
   - Year-over-year growth rate for each year
   - 5-year CAGR: `(Revenue_latest / Revenue_earliest)^(1/years) - 1`
   - Flag any years with revenue decline

2. **Margin analysis** (calculate for each year, show the trend):
   - Gross Margin = Gross Profit / Revenue
   - Operating Margin = Operating Income / Revenue
   - Net Margin = Net Income / Revenue

3. **Margin benchmarks** (from [financial-ratios-benchmarks.md](references/financial-ratios-benchmarks.md)):
   - Compare each margin to sector benchmarks
   - Flag margins that are significantly above or below sector range

4. **EPS analysis**:
   - EPS trend over 5 years
   - EPS growth consistency (note any years of decline)

5. **Expense structure**:
   - Cost of revenue as % of revenue (trend)
   - SG&A as % of revenue (trend)
   - R&D as % of revenue (trend, if applicable)
   - Flag any expense category growing faster than revenue

6. **Contextual explanation** (REQUIRED — use web search results from Step 1b):
   - For each significant trend or inflection point in the data above, provide a **why** explanation using the earnings call and industry context gathered in Step 1b.
   - If revenue growth changed direction significantly (acceleration or deceleration > 10pp), run an additional search:
     `web_search("[COMPANY] revenue [growth/decline] reason [YEAR]")`
   - If margins shifted by more than 5pp year-over-year, run an additional search:
     `web_search("[COMPANY] margin [expansion/compression] [YEAR]")`
   - **Do not present a data table without narrative.** Every major trend must have a "why" attached, citing the source (earnings call, industry report, or company announcement).

Present as a table:

| Metric | Year 1 | Year 2 | Year 3 | Year 4 | Year 5 | 5Y CAGR |
|--------|--------|--------|--------|--------|--------|---------|

### Step 3: Balance Sheet Analysis

Analyze the balance sheet across all 5 annual periods:

1. **Liquidity**:
   - Current Ratio = Current Assets / Current Liabilities
   - Quick Ratio = (Current Assets - Inventory) / Current Liabilities
   - Cash and equivalents trend

2. **Leverage**:
   - Cash vs. Total Debt (short-term + long-term debt)
   - Debt-to-Equity = Total Liabilities / Total Shareholders' Equity
   - Interest Coverage = Operating Income / Interest Expense
   - Debt payoff capacity = Total Debt / Net Income (in years)

3. **Asset quality**:
   - Receivables Turnover = Revenue / Accounts Receivable
   - Inventory Turnover = Cost of Revenue / Inventory (if applicable)
   - Goodwill as % of Total Assets (flag if > 30%)

4. **Equity structure**:
   - Retained earnings: year-over-year changes (growing?)
   - Preferred stock: present or absent?
   - Treasury stock: present? growing? (indicates buybacks)

5. **Working capital trend**:
   - Net Working Capital = Current Assets - Current Liabilities
   - Direction of change over 5 years

6. **Contextual explanation** (use web search results from Step 1b + additional searches as needed):
   - Explain major balance sheet changes using earnings call context from Step 1b.
   - If total debt changed significantly (> 30% YoY), you MUST search for the reason:
     `web_search("[COMPANY] debt [issuance/repayment] [YEAR]")`
   - If goodwill jumped, you MUST search for acquisition context:
     `web_search("[COMPANY] acquisition [YEAR]")`
   - Large treasury stock changes → confirm buyback program details:
     `web_search("[COMPANY] share buyback program")`

Compare key ratios to sector benchmarks from [financial-ratios-benchmarks.md](references/financial-ratios-benchmarks.md).

### Step 4: Cash Flow Statement Analysis

Analyze cash flow statements across all 5 annual periods:

1. **Operating cash flow quality**:
   - OCF vs. Net Income ratio for each year
   - Target: OCF/NI > 1.0 (cash earnings exceed accrual earnings)
   - Trend direction

2. **Free cash flow**:
   - FCF = Operating Cash Flow - Capital Expenditure
   - FCF Margin = FCF / Revenue
   - 5-year FCF trend and CAGR

3. **Capital intensity**:
   - CapEx / Revenue ratio
   - CapEx / Net Income ratio (Buffett benchmark: < 25% excellent, < 50% acceptable)
   - Is CapEx growing faster than revenue? (potential red flag)

4. **Cash flow composition**:
   - Net cash from operating activities (should be consistently positive)
   - Net cash from investing activities (negative = investing in growth)
   - Net cash from financing activities (pattern: debt vs. equity funded?)

5. **Shareholder returns**:
   - Dividends paid (from financing activities)
   - Share buybacks / treasury stock repurchase
   - Total payout ratio = (Dividends + Buybacks) / Net Income
   - Is the company returning cash while maintaining growth?

6. **Contextual explanation** (use web search results from Step 1b + additional searches as needed):
   - Explain cash flow patterns using earnings call context from Step 1b.
   - If CapEx spiked significantly in a particular year, you MUST search for what was built:
     `web_search("[COMPANY] capital expenditure investment [YEAR]")`
   - If FCF diverged sharply from net income, search for restructuring or working capital events.

Present a summary table:

| Metric | Year 1 | Year 2 | Year 3 | Year 4 | Year 5 |
|--------|--------|--------|--------|--------|--------|

### Step 5: Buffett Competitive Advantage Scoring

Apply the scoring framework from [buffett-checklist.md](references/buffett-checklist.md).

For each of the 13 criteria across 4 categories:
1. Calculate the metric value from the data gathered in Steps 1-4
2. Determine the score based on the threshold table
3. Note the sector-specific caveats (Financials, Utilities, REITs, Growth-stage)

Present the full scorecard table and the overall rating (Excellent / Good / Average / Weak).

### Step 6: Quality of Earnings Assessment

Assess whether reported earnings are backed by real cash and sustainable operations:

1. **Accrual ratio**:
   - Formula: (Net Income - Operating Cash Flow) / Total Assets
   - Interpretation: Lower is better. High positive values suggest earnings are driven by accruals rather than cash.
   - Red flag threshold: > 10%

2. **Revenue recognition quality**:
   - Compare Accounts Receivable growth rate vs. Revenue growth rate
   - If AR grows significantly faster than revenue → potential aggressive revenue recognition
   - Red flag threshold: AR growth > Revenue growth + 5 percentage points

3. **Inventory quality** (if applicable):
   - Compare Inventory growth rate vs. Cost of Revenue growth rate
   - Rising inventory vs. flat/declining COGS → potential obsolescence risk
   - Red flag threshold: Inventory growth > COGS growth + 10 percentage points

4. **One-time items**:
   - Identify significant non-recurring charges or gains in the income statement
   - Calculate adjusted net income excluding one-time items
   - Compare adjusted vs. reported margins

5. **Deferred revenue trend** (if applicable):
   - Growing deferred revenue is a positive signal (future revenue already contracted)
   - Declining deferred revenue may signal weakening demand pipeline

6. **External validation** (web search):
   - If any red flags were triggered above, search for corroborating or mitigating context:
     `web_search("[COMPANY] accounting concerns OR restatement OR SEC inquiry")`
   - Check for auditor changes (can signal accounting issues):
     `web_search("[COMPANY] auditor change OR audit opinion")`
   - Only run these searches if quantitative red flags exist. Do not search proactively for every company.

Summarize quality of earnings as: **High** / **Moderate** / **Low** with supporting evidence.

### Step 7: SEC Filing Qualitative Analysis

Pull and analyze the most recent annual or quarterly filing:

1. **Get filing list**:
   ```
   action: "get_filings"
   params: { ticker: "[TICKER]", filing_type: "10-K", limit: 1 }
   ```
   If 10-K is not recent enough, also pull 10-Q:
   ```
   action: "get_filings"
   params: { ticker: "[TICKER]", filing_type: "10-Q", limit: 1 }
   ```

2. **Read MD&A section** (Management's Discussion and Analysis):
   ```
   action: "get_filing_items"
   params: { ticker: "[TICKER]", filing_type: "10-K", item: "7" }
   ```
   For 10-Q, MD&A is item "2":
   ```
   action: "get_filing_items"
   params: { ticker: "[TICKER]", filing_type: "10-Q", item: "2" }
   ```

3. **Read Risk Factors**:
   ```
   action: "get_filing_items"
   params: { ticker: "[TICKER]", filing_type: "10-K", item: "1A" }
   ```

4. **Extract and analyze**:
   - Management's explanation of revenue and margin trends
   - Forward-looking statements and guidance
   - Key risk factors that could impact financial health
   - Any disclosures about accounting policy changes
   - Cross-validate: Does management narrative align with the quantitative data from Steps 2-4?
   - Flag contradictions between management tone and actual numbers

5. **Supplement with earnings call transcript** (REQUIRED — web search/fetch):
   You MUST search for and incorporate the most recent earnings call. This is critical for understanding management's forward-looking view.
   - Search for the transcript:
     `web_search("[COMPANY] [QUARTER] [YEAR] earnings call transcript")`
   - If a transcript URL is found, use `web_fetch` to read key sections (CEO/CFO prepared remarks, Q&A highlights).
   - Extract: forward guidance, segment-level commentary, management tone on competitive position, key analyst concerns.
   - Cross-reference earnings call statements with MD&A disclosures — flag any inconsistencies.

6. **Summarize key insights**:
   - What management says about the business trajectory
   - Material risks not visible in the numbers alone
   - Any changes in risk factors vs. prior filings (if noticeable)
   - Key analyst questions and management responses from earnings call (if available)

### Step 8: Peer Comparison (Conditional)

**Execute this step only when the user explicitly requests peer comparison or industry benchmarking.**

1. **Identify peers**:
   - Use the `sector` and `industry` from `get_company_facts`
   - Select 2-3 publicly traded competitors in the same industry
   - If the user specifies peers, use those instead

2. **Pull peer data** (for each peer):
   ```
   action: "get_financial_metrics"
   params: { ticker: "[PEER_TICKER]", period: "quarterly", limit: 1 }
   ```
   ```
   action: "get_income_statements"
   params: { ticker: "[PEER_TICKER]", period: "annual", limit: 1 }
   ```
   ```
   action: "get_balance_sheets"
   params: { ticker: "[PEER_TICKER]", period: "annual", limit: 1 }
   ```

3. **Comparative table**:

   | Metric | [TARGET] | [PEER 1] | [PEER 2] | [PEER 3] | Sector Avg |
   |--------|----------|----------|----------|----------|------------|
   | Revenue Growth (YoY) | | | | | |
   | Gross Margin | | | | | |
   | Net Margin | | | | | |
   | ROE | | | | | |
   | D/E Ratio | | | | | |
   | FCF Margin | | | | | |
   | P/E Ratio | | | | | |

4. **Competitive position assessment**:
   - Where does the target company rank among peers on each metric?
   - Identify clear advantages and disadvantages relative to peers
   - Note if the target trades at a premium or discount to peers and whether it's justified

### Step 9: Present Findings

Compile the full analysis into a structured report. Follow this exact structure:

#### 1. Executive Summary
- Company name, ticker, sector, current price
- One-paragraph thesis: Is this a financially healthy company with a durable competitive advantage?
- Financial health rating from Buffett scorecard (Excellent / Good / Average / Weak)
- Earnings quality assessment (High / Moderate / Low)

#### 2. Financial Health Scorecard
- Full Buffett checklist scorecard table from Step 5
- Total score and rating

#### 3. Trend Dashboard
- 5-year key metrics trend table from Steps 2-4:

| Metric | Y1 | Y2 | Y3 | Y4 | Y5 | Trend |
|--------|----|----|----|----|----|----|
| Revenue | | | | | | arrow |
| Gross Margin | | | | | | arrow |
| Net Margin | | | | | | arrow |
| ROE | | | | | | arrow |
| D/E Ratio | | | | | | arrow |
| FCF | | | | | | arrow |
| OCF/NI | | | | | | arrow |
| CapEx/NI | | | | | | arrow |

Use directional indicators in the Trend column.

#### 4. Quality of Earnings
- Summary from Step 6 with key metrics and assessment

#### 5. Key Strengths & Red Flags
- **Strengths**: List 3-5 financial strengths with supporting data
- **Red Flags**: List any warning signs discovered during analysis. If none, state "No material red flags identified."

Common red flags to watch for:
- Revenue growth but declining margins
- Net income growing but OCF declining
- AR growing faster than revenue
- Inventory building up vs. flat COGS
- Rising debt with declining interest coverage
- Retained earnings declining
- Large goodwill relative to total assets
- CapEx consistently > 50% of net income
- Management tone in MD&A contradicts financial data

#### 6. SEC Filing Insights
- Key findings from Step 7
- Management's outlook and material risks

#### 7. Peer Comparison (if Step 8 was executed)
- Comparative table and competitive position assessment

### Guardrails

- Always state the date range of financial data used.
- If any data is missing or unavailable, explicitly note it and adjust the analysis scope.
- Do not present calculated ratios as precise — round to one decimal place.
- Clearly distinguish between facts (from data) and interpretive conclusions.
- The Buffett scorecard is a screening framework, not a buy/sell recommendation. State this in the output.
- For non-US companies or companies not filing with the SEC, skip Step 7 and note the limitation.
- Output language must match the user's input language (Chinese input → Chinese output, English input → English output).

### Web Search Requirements

**Minimum mandatory searches (you MUST perform these):**
1. Earnings call highlights (Step 1b) — for management's own explanation of results
2. Industry outlook (Step 1b) — for macro/sector context
3. Earnings call transcript (Step 7) — for forward guidance and analyst Q&A

**Additional searches (trigger when data shows anomalies):**
- Revenue or margin inflection points (Steps 2-4)
- Major debt changes or acquisitions (Step 3)
- CapEx spikes (Step 4)
- Quality-of-earnings red flags (Step 6)

**Search principles:**
- **Source quality**: Prefer primary sources (SEC filings, company press releases, earnings call transcripts) over secondary sources (analyst blogs, news aggregators).
- **Cite with dates**: Always include source name and date when referencing external information.
- **Separate fact from opinion**: Label analyst or media commentary as external opinion, not fact.
- **Total budget**: Expect 3-8 web searches per analysis. Fewer than 3 means you are likely missing critical context.
