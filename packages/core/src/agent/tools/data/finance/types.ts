/**
 * Finance domain types for the data tool.
 */

/** All supported finance actions */
export const FINANCE_ACTIONS = [
  // Price data
  "get_crypto_price_snapshot",
  "get_crypto_prices",
  "get_available_crypto_tickers",
  // Financial statements
  "get_income_statements",
  "get_balance_sheets",
  "get_cash_flow_statements",
  "get_all_financial_statements",
  // Metrics & estimates
  "get_financial_metrics",
  "get_analyst_estimates",
  // Company info
  "get_news",
  "get_insider_trades",
  "get_segmented_revenues",
  "get_company_facts",
  // SEC filings
  "get_filings",
  "get_filing_items",
] as const;

export type FinanceAction = (typeof FINANCE_ACTIONS)[number];

/** Set for O(1) lookup */
export const FINANCE_ACTION_SET = new Set<string>(FINANCE_ACTIONS);
