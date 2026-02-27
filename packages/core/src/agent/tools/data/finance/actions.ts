/**
 * Finance action handlers.
 *
 * Maps each action name to the corresponding Financial Datasets API call.
 */

import type { FinanceAction } from "./types.js";
import { FINANCE_ACTION_SET } from "./types.js";
import { financeFetch } from "./api.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

function requireParam(params: Params, name: string): string {
  const value = params[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required parameter: ${name}`);
  }
  return String(value);
}

function optionalString(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function optionalNumber(params: Params, name: string): number | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  return Number(value);
}

function optionalStringArray(params: Params, name: string): string[] | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/** Extract common financial statement filter params */
function statementFilters(params: Params) {
  return {
    ticker: requireParam(params, "ticker"),
    period: requireParam(params, "period"),
    limit: optionalNumber(params, "limit"),
    report_period_gt: optionalString(params, "report_period_gt"),
    report_period_gte: optionalString(params, "report_period_gte"),
    report_period_lt: optionalString(params, "report_period_lt"),
    report_period_lte: optionalString(params, "report_period_lte"),
  };
}

// ─── Action result type ─────────────────────────────────────────────────────

export interface FinanceActionResult {
  data: unknown;
  sourceUrl: string;
}

// ─── Action handlers ────────────────────────────────────────────────────────

type ActionHandler = (params: Params, signal?: AbortSignal) => Promise<FinanceActionResult>;

const handlers: Record<FinanceAction, ActionHandler> = {
  // ── Prices ──────────────────────────────────────────────────────────────

  get_crypto_price_snapshot: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch("/crypto/prices/snapshot", { ticker }, signal);
    return { data: (data as Record<string, unknown>).snapshot ?? data, sourceUrl: url };
  },

  get_crypto_prices: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const start_date = requireParam(params, "start_date");
    const end_date = requireParam(params, "end_date");
    const { data, url } = await financeFetch(
      "/crypto/prices",
      {
        ticker,
        start_date,
        end_date,
        interval: optionalString(params, "interval") ?? "day",
        interval_multiplier: optionalNumber(params, "interval_multiplier"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).prices ?? data, sourceUrl: url };
  },

  get_available_crypto_tickers: async (_params, signal) => {
    const { data, url } = await financeFetch("/crypto/prices/tickers", {}, signal);
    return { data: (data as Record<string, unknown>).tickers ?? data, sourceUrl: url };
  },

  // ── Financial statements ────────────────────────────────────────────────

  get_income_statements: async (params, signal) => {
    const filters = statementFilters(params);
    const { data, url } = await financeFetch("/financials/income-statements", filters, signal);
    return { data: (data as Record<string, unknown>).income_statements ?? data, sourceUrl: url };
  },

  get_balance_sheets: async (params, signal) => {
    const filters = statementFilters(params);
    const { data, url } = await financeFetch("/financials/balance-sheets", filters, signal);
    return { data: (data as Record<string, unknown>).balance_sheets ?? data, sourceUrl: url };
  },

  get_cash_flow_statements: async (params, signal) => {
    const filters = statementFilters(params);
    const { data, url } = await financeFetch("/financials/cash-flow-statements", filters, signal);
    return { data: (data as Record<string, unknown>).cash_flow_statements ?? data, sourceUrl: url };
  },

  get_all_financial_statements: async (params, signal) => {
    const filters = statementFilters(params);
    const { data, url } = await financeFetch("/financials", filters, signal);
    return { data: (data as Record<string, unknown>).financials ?? data, sourceUrl: url };
  },

  // ── Metrics & estimates ─────────────────────────────────────────────────

  get_financial_metrics: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch(
      "/financial-metrics",
      {
        ticker,
        period: optionalString(params, "period"),
        limit: optionalNumber(params, "limit"),
        report_period: optionalString(params, "report_period"),
        report_period_gt: optionalString(params, "report_period_gt"),
        report_period_gte: optionalString(params, "report_period_gte"),
        report_period_lt: optionalString(params, "report_period_lt"),
        report_period_lte: optionalString(params, "report_period_lte"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).financial_metrics ?? data, sourceUrl: url };
  },

  get_analyst_estimates: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch(
      "/analyst-estimates",
      {
        ticker,
        period: optionalString(params, "period"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).analyst_estimates ?? data, sourceUrl: url };
  },

  // ── Company info ────────────────────────────────────────────────────────

  get_news: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch(
      "/news",
      {
        ticker,
        start_date: optionalString(params, "start_date"),
        end_date: optionalString(params, "end_date"),
        limit: optionalNumber(params, "limit"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).news ?? data, sourceUrl: url };
  },

  get_insider_trades: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch(
      "/insider-trades",
      {
        ticker: ticker.toUpperCase(),
        limit: optionalNumber(params, "limit"),
        filing_date: optionalString(params, "filing_date"),
        filing_date_gt: optionalString(params, "filing_date_gt"),
        filing_date_gte: optionalString(params, "filing_date_gte"),
        filing_date_lt: optionalString(params, "filing_date_lt"),
        filing_date_lte: optionalString(params, "filing_date_lte"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).insider_trades ?? data, sourceUrl: url };
  },

  get_segmented_revenues: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const period = requireParam(params, "period");
    const { data, url } = await financeFetch(
      "/financials/segmented-revenues",
      {
        ticker,
        period,
        limit: optionalNumber(params, "limit"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).segmented_revenues ?? data, sourceUrl: url };
  },

  get_company_facts: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch("/company/facts", { ticker }, signal);
    return { data: (data as Record<string, unknown>).company_facts ?? data, sourceUrl: url };
  },

  // ── SEC filings ─────────────────────────────────────────────────────────

  get_filings: async (params, signal) => {
    const ticker = requireParam(params, "ticker");
    const { data, url } = await financeFetch(
      "/filings",
      {
        ticker,
        filing_type: optionalString(params, "filing_type"),
        limit: optionalNumber(params, "limit"),
      },
      signal,
    );
    return { data: (data as Record<string, unknown>).filings ?? data, sourceUrl: url };
  },

  get_filing_items: async (params, signal) => {
    const ticker = requireParam(params, "ticker").toUpperCase();
    const filing_type = requireParam(params, "filing_type");
    const { data, url } = await financeFetch(
      "/filings/items",
      {
        ticker,
        filing_type,
        accession_number: optionalString(params, "accession_number"),
        item: optionalStringArray(params, "item"),
      },
      signal,
    );
    return { data, sourceUrl: url };
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute a finance domain action.
 *
 * @throws Error if the action is unknown or required params are missing.
 */
export function executeFinanceAction(
  action: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FinanceActionResult> {
  if (!FINANCE_ACTION_SET.has(action)) {
    throw new Error(
      `Unknown finance action: "${action}". Available: ${[...FINANCE_ACTION_SET].join(", ")}`,
    );
  }
  return handlers[action as FinanceAction](params, signal);
}
