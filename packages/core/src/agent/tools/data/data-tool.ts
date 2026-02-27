/**
 * Unified data tool — structured access to domain-specific data sources.
 *
 * Currently supports the "finance" domain (Financial Datasets API).
 * Designed as a stable interface: the backend can be swapped from
 * direct API calls to a Multica Data Service without changing the tool schema.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { executeFinanceAction } from "./finance/actions.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

const DataToolSchema = Type.Object({
  domain: Type.String({
    description: 'Data domain. Currently supported: "finance".',
  }),
  action: Type.String({
    description:
      "Action to perform within the domain.\n\n" +
      "FINANCE DOMAIN ACTIONS:\n" +
      "Prices:\n" +
      "  get_crypto_price_snapshot — params: { ticker } (e.g. BTC-USD)\n" +
      "  get_crypto_prices — params: { ticker, start_date, end_date, interval?, interval_multiplier? }\n" +
      "  get_available_crypto_tickers — params: {}\n" +
      "Financial Statements (period: annual|quarterly|ttm):\n" +
      "  get_income_statements — params: { ticker, period, limit?, report_period_gt/gte/lt/lte? }\n" +
      "  get_balance_sheets — same params\n" +
      "  get_cash_flow_statements — same params\n" +
      "  get_all_financial_statements — same params (returns all three)\n" +
      "Metrics:\n" +
      "  get_financial_metrics — params: { ticker, period?, limit?, report_period*? }\n" +
      "  get_analyst_estimates — params: { ticker, period? }\n" +
      "Company:\n" +
      "  get_news — params: { ticker, start_date?, end_date?, limit? }\n" +
      "  get_insider_trades — params: { ticker, limit?, filing_date*? }\n" +
      "  get_segmented_revenues — params: { ticker, period, limit? }\n" +
      "  get_company_facts — params: { ticker }\n" +
      "SEC Filings:\n" +
      "  get_filings — params: { ticker, filing_type?, limit? }\n" +
      "  get_filing_items — params: { ticker, filing_type, accession_number?, item? }",
  }),
  params: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Action-specific parameters as key-value pairs. " +
      "Common: ticker (string, e.g. 'AAPL'), period ('annual'|'quarterly'|'ttm'), " +
      "limit (number), start_date/end_date ('YYYY-MM-DD'), " +
      "interval ('day'|'week'|'month'|'year'), filing_type ('10-K'|'10-Q'|'8-K').",
  }),
});

// ─── Types ──────────────────────────────────────────────────────────────────

type DataToolArgs = {
  domain: string;
  action: string;
  params: Record<string, unknown>;
};

export type DataToolResult = {
  domain: string;
  action: string;
  data: unknown;
  sourceUrl?: string;
};

// ─── Factory ────────────────────────────────────────────────────────────────

export function createDataTool(): AgentTool<typeof DataToolSchema, DataToolResult> {
  return {
    name: "data",
    label: "Data",
    description:
      "Query structured data from external sources. " +
      'Supports domain="finance" for stock prices, financial statements, key metrics, ' +
      "SEC filings, analyst estimates, insider trades, news, and crypto data.",
    parameters: DataToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const { domain, action, params } = args as DataToolArgs;

      if (domain !== "finance") {
        throw new Error(`Unknown domain: "${domain}". Currently supported: "finance".`);
      }

      const result = await executeFinanceAction(action, params ?? {}, signal);
      const payload: DataToolResult = {
        domain,
        action,
        data: result.data,
        sourceUrl: result.sourceUrl,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  };
}
