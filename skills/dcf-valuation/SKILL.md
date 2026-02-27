---
name: DCF Valuation
description: Perform Discounted Cash Flow (DCF) valuation analysis for public companies. Use when the user asks to value a stock, calculate intrinsic value, fair value, perform DCF analysis, determine if a stock is undervalued or overvalued, or estimate a price target.
version: 1.1.1
metadata:
  emoji: "\U0001F9EE"
  tags:
    - finance
    - valuation
    - dcf
userInvocable: true
disableModelInvocation: false
---

## Instructions

Perform a rigorous Discounted Cash Flow (DCF) valuation. Follow all steps and show your work. Use external macro context when assumptions are time-sensitive (for example, risk-free rate regime shifts).

### Progress Checklist

```
DCF Analysis Progress:
- [ ] Step 1: Gather financial data
- [ ] Step 2: Calculate historical FCF and growth
- [ ] Step 3: Estimate WACC
- [ ] Step 4: Project future cash flows
- [ ] Step 5: Calculate present value and fair value
- [ ] Step 6: Sensitivity analysis
- [ ] Step 7: Validate results
- [ ] Step 8: Present findings
```

### Step 1: Gather Financial Data

Use `data` tool with `domain="finance"` for all calls:

1. **Cash Flow History** (5 years):
   ```
   action: "get_cash_flow_statements"
   params: { ticker: "[TICKER]", period: "annual", limit: 5 }
   ```
   Extract: `free_cash_flow`, `net_cash_flow_from_operations`, `capital_expenditure`
   Fallback: FCF = Operating Cash Flow - CapEx

2. **Income Statements** (5 years):
   ```
   action: "get_income_statements"
   params: { ticker: "[TICKER]", period: "annual", limit: 5 }
   ```
   Extract: `revenue`, `operating_income`, `net_income`, `income_tax_expense`

3. **Balance Sheet** (latest):
   ```
   action: "get_balance_sheets"
   params: { ticker: "[TICKER]", period: "annual", limit: 1 }
   ```
   Extract: `total_debt`, `cash_and_equivalents`, `outstanding_shares`

4. **Financial Metrics** (current):
   ```
   action: "get_financial_metrics"
   params: { ticker: "[TICKER]", period: "quarterly", limit: 1 }
   ```
   Extract: `market_cap`, `enterprise_value`, `return_on_invested_capital`, `debt_to_equity`, `free_cash_flow_per_share`

5. **Analyst Estimates**:
   ```
   action: "get_analyst_estimates"
   params: { ticker: "[TICKER]", period: "annual" }
   ```
   Extract: Forward EPS estimates for growth validation

6. **Company Facts**:
   ```
   action: "get_company_facts"
   params: { ticker: "[TICKER]" }
   ```
   Extract: `sector` — use to determine WACC range from [sector-wacc.md](references/sector-wacc.md)

7. **Current Price** (use web search):
   ```
   web_search("[TICKER] stock price today")
   ```

8. **Recent Event Context**:
- Pull company-specific headlines with:
  ```
  action: "get_news"
  params: { ticker: "[TICKER]", limit: 10 }
  ```
- Use this to flag event risk (guidance reset, litigation, regulation, one-off gains/losses) that may distort near-term FCF extrapolation.

### Step 2: Calculate Historical FCF and Growth

- Compute FCF for each of the last 5 years
- Calculate 5-year FCF CAGR: `(FCF_latest / FCF_earliest)^(1/years) - 1`
- Cross-validate with: revenue growth, operating income growth, analyst EPS growth
- **Cap projected growth at 15%** (sustained higher growth is rare)
- If FCF is volatile, weight analyst estimates more heavily

### Step 3: Estimate WACC

Use the company's `sector` to look up the base WACC range from [sector-wacc.md](references/sector-wacc.md).

**Calculate WACC:**
```
WACC = (E/V) * Re + (D/V) * Rd * (1 - Tax Rate)

Where:
  E = Market cap (equity value)
  D = Total debt
  V = E + D
  Re = Risk-free rate + Beta * Equity Risk Premium
  Rd = Cost of debt (estimate from interest expense / total debt)
  Tax Rate = Effective tax rate from income statements
```

**Default assumptions:**
- Risk-free rate: pull latest 10-year Treasury yield using `web_search` (preferred) and cite date/source. Fallback range: ~4.0-4.5%.
- Equity risk premium: ~5.5%
- If beta unavailable, use sector average

**Sanity check:** WACC should be 2-4% below ROIC for value-creating companies.

### Step 4: Project Future Cash Flows (Years 1-5)

- Apply growth rate with annual decay (multiply by 0.95 each year)
- Year 1: FCF * (1 + growth_rate)
- Year 2: FCF * (1 + growth_rate * 0.95)
- Year 3: FCF * (1 + growth_rate * 0.90)
- Year 4: FCF * (1 + growth_rate * 0.85)
- Year 5: FCF * (1 + growth_rate * 0.80)

**Terminal Value** (Gordon Growth Model):
```
TV = FCF_Year5 * (1 + g) / (WACC - g)
Where g = terminal growth rate (2.5% default, GDP proxy)
```

### Step 5: Calculate Present Value and Fair Value

```
PV of each FCF = FCF_t / (1 + WACC)^t
PV of Terminal Value = TV / (1 + WACC)^5

Enterprise Value = Sum of PV(FCFs) + PV(Terminal Value)
Net Debt = Total Debt - Cash and Equivalents
Equity Value = Enterprise Value - Net Debt
Fair Value per Share = Equity Value / Shares Outstanding
```

### Step 6: Sensitivity Analysis

Create a matrix varying two key assumptions:

| | TG 2.0% | TG 2.5% | TG 3.0% |
|---|---|---|---|
| **WACC -1%** | $ | $ | $ |
| **WACC base** | $ | $ | $ |
| **WACC +1%** | $ | $ | $ |

(TG = Terminal Growth Rate)

### Step 7: Validate Results

Before presenting, check:

1. **EV comparison**: Calculated EV within 30% of reported enterprise_value
   - If off by >30%, revisit WACC or growth assumptions
2. **Terminal value ratio**: Should be 50-80% of total EV for mature companies
   - If >90%, growth rate may be too high
   - If <40%, near-term projections may be aggressive
3. **FCF yield check**: Compare fair value FCF yield to current market FCF yield

If validation fails, adjust assumptions and recalculate.

### Step 8: Present Results

Format clearly with:

1. **Executive Summary**
   - Current price vs. fair value estimate
   - Upside/downside percentage
   - Verdict: Undervalued / Fairly Valued / Overvalued

2. **Key Assumptions Table**
   | Assumption | Value | Source |
   |---|---|---|
   | Growth Rate | X% | 5Y CAGR + analyst cross-check |
   | WACC | X% | Sector range + company adjustments |
   | Terminal Growth | X% | GDP proxy |
   | Tax Rate | X% | Effective rate from financials |

3. **Projected FCF Table**
   | Year | FCF | Growth | PV of FCF |
   |---|---|---|---|

4. **Valuation Bridge**
   - PV of projected FCFs
   - PV of Terminal Value
   - = Enterprise Value
   - - Net Debt
   - = Equity Value
   - / Shares Outstanding
   - = **Fair Value per Share**

5. **Sensitivity Matrix** (from Step 6)

6. **Risks & Caveats**
   - Key risks to the valuation thesis
   - DCF limitations (sensitive to growth and WACC assumptions)
   - Company-specific caveats (high debt, cyclicality, early-stage, etc.)
