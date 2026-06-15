// Zerion API response types.
//
// Zerion follows the JSON:API spec — every response has `data` (the primary
// resource(s)) and an optional `included` (related resources). We type only
// the attributes we actually consume; unused fields stay `unknown` to keep
// noise low without hiding real shapes when something diverges.

export interface ZerionQuantity {
  int: string;
  decimals: number;
  float: number;
  numeric: string;
}

export interface ZerionFungibleInfo {
  name: string;
  symbol: string;
  description?: string | null;
  icon: { url: string | null } | null;
  flags?: { verified?: boolean };
  implementations: Array<{
    chain_id: string;
    address: string | null;
    decimals: number;
  }>;
}

export interface ZerionPositionAttributes {
  name: string;
  quantity: ZerionQuantity;
  /** USD value of this position. May be null for unpriced assets. */
  value: number | null;
  /** Spot price per unit, in the requested currency. */
  price: number;
  changes: {
    /** Absolute USD change over the past 24h for this position. */
    absolute_1d: number;
    /** Percent change over the past 24h, as a fraction (e.g. 0.0241 = +2.41%). */
    percent_1d: number;
  } | null;
  fungible_info: ZerionFungibleInfo;
  flags: {
    displayable: boolean;
    is_trash: boolean;
  };
  position_type: 'wallet' | 'deposit' | 'loan' | 'staked' | 'reward' | string;
  protocol?: string | null;
  application_metadata?: {
    name?: string;
    icon?: { url: string | null };
    url?: string;
  } | null;
}

export interface ZerionPosition {
  type: 'positions';
  id: string;
  attributes: ZerionPositionAttributes;
  relationships?: {
    chain?: { data: { type: 'chains'; id: string } };
    fungible?: { data: { type: 'fungibles'; id: string } };
  };
}

export interface ZerionPositionsResponse {
  data: ZerionPosition[];
  links?: { self?: string; next?: string };
}

export interface ZerionPortfolioAttributes {
  /** USD totals broken down by position type (wallet / deposited / staked / borrowed / locked). */
  positions_distribution_by_type: {
    wallet: number;
    deposited: number;
    borrowed: number;
    locked: number;
    staked: number;
  };
  /** USD totals broken down by chain id (e.g. ethereum, base, unichain, …). */
  positions_distribution_by_chain: Record<string, number>;
  /** Aggregate value across all position types. */
  total: { positions: number };
  changes: {
    /** Absolute USD change over the past 24h. */
    absolute_1d: number;
    /** Percent change as a fraction (0.0241 = +2.41%). */
    percent_1d: number;
  };
}

export interface ZerionPortfolioResponse {
  data: {
    type: 'portfolios';
    id: string;
    attributes: ZerionPortfolioAttributes;
  };
}

export type ZerionTxOperationType =
  | 'send'
  | 'receive'
  | 'trade'
  | 'execute'
  | 'deposit'
  | 'withdraw'
  | 'approve'
  | 'revoke'
  | 'borrow'
  | 'repay'
  | 'stake'
  | 'unstake'
  | 'claim'
  | 'mint'
  | 'burn'
  | 'deploy'
  | 'cancel'
  | string;

export type ZerionTxStatus = 'confirmed' | 'failed' | 'pending' | string;

export interface ZerionTxTransfer {
  fungible_info: ZerionFungibleInfo;
  /** "in" — wallet received; "out" — wallet sent. */
  direction: 'in' | 'out';
  quantity: ZerionQuantity;
  price: number | null;
  value: number | null;
  sender: string;
  recipient: string;
}

export interface ZerionTxApproval {
  fungible_info: ZerionFungibleInfo;
  quantity: ZerionQuantity | null;
  spender: string;
}

export interface ZerionTransactionAttributes {
  operation_type: ZerionTxOperationType;
  hash: string;
  /** ISO 8601 timestamp. May be null for pending txs. */
  mined_at: string | null;
  mined_at_block?: number | null;
  sent_from: string;
  sent_to: string;
  status: ZerionTxStatus;
  nonce?: number | null;
  fee?: {
    fungible_info: ZerionFungibleInfo;
    quantity: ZerionQuantity;
    price: number | null;
    value: number | null;
  };
  transfers?: ZerionTxTransfer[];
  approvals?: ZerionTxApproval[];
  application_metadata?: {
    name?: string;
    icon?: { url: string | null };
    contract_address?: string;
  } | null;
}

export interface ZerionTransaction {
  type: 'transactions';
  id: string;
  attributes: ZerionTransactionAttributes;
  relationships?: {
    chain?: { data: { type: 'chains'; id: string } };
  };
}

export interface ZerionTransactionsResponse {
  data: ZerionTransaction[];
  links?: { self?: string; next?: string };
}

export interface ZerionPnlAttributes {
  currency: string;
  net_invested: number;
  total_fees: number;
  unrealized_gain: number;
  realized_gain: number;
  received_external: number;
  sent_external: number;
  received_for_fungibles: number;
  sent_for_fungibles: number;
}

export interface ZerionPnlResponse {
  data: {
    type: 'pnl';
    id: string;
    attributes: ZerionPnlAttributes;
  };
}

export interface ZerionFungibleAttributes {
  name: string;
  symbol: string;
  description?: string | null;
  icon: { url: string | null } | null;
  market_data?: {
    price?: number;
    market_cap?: number;
    fully_diluted_valuation?: number;
    total_supply?: number;
    circulating_supply?: number;
    changes?: {
      percent_1d?: number;
      percent_30d?: number;
      percent_90d?: number;
      percent_365d?: number;
    };
  };
}

export interface ZerionFungibleResponse {
  data: {
    type: 'fungibles';
    id: string;
    attributes: ZerionFungibleAttributes;
  };
}
