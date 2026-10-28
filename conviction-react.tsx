"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import type { Deployment, LockSnapshot } from "./conviction-client";
import { readConvLocks, type LockPolicy } from "./read-conv-locks";

type PositionPage = Awaited<ReturnType<typeof readConvLocks>>;

export interface ConvictionPositionsOptions {
  deployment: Deployment;
  account?: Address;
  policy: LockPolicy;
  /** Each explicit request reads 1 to 100 positions. Defaults to 20. */
  pageSize?: number;
  /** Optional adapter for a preview or an application-specific data source. */
  readPage?: typeof readConvLocks;
}

export interface ConvictionPositionsState {
  status: "idle" | "loading" | "success" | "error";
  positions: PositionPage["positions"];
  snapshot?: LockSnapshot;
  blockTimestamp?: bigint;
  hasMore: boolean;
  isLoadingMore: boolean;
  error?: string;
}

interface StoredState extends ConvictionPositionsState {
  scope: string;
  reader: typeof readConvLocks;
}

interface Scan {
  scope: string;
  reader: typeof readConvLocks;
  cancel(): void;
  loadMore(): void;
}

/** Read manually paginated positions at one block. Refresh starts a new snapshot. */
export function useConvictionPositions({
  deployment, account, policy, pageSize = 20, readPage = readConvLocks,
}: ConvictionPositionsOptions) {
  const [revision, setRevision] = useState(0);
  const scan = useRef<Scan | null>(null);
  const configurationError = !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    ? "pageSize must be an integer from 1 to 100."
    : policy.minimumAmount <= 0n || policy.minimumRemainingSeconds <= 0n
      ? "Use a positive minimum amount and remaining duration for the preview policy."
      : undefined;
  // Object literals supplied by a parent do not restart a scan on every render.
  const scope = JSON.stringify([
    deployment.chain.id, deployment.rpcUrl, deployment.vaultAddress, deployment.convictionAddress,
    account, policy.minimumAmount.toString(), policy.minimumRemainingSeconds.toString(), pageSize, revision,
  ]);
  const initial: StoredState = {
    scope, reader: readPage, positions: [], hasMore: false, isLoadingMore: false,
    status: configurationError ? "error" : account ? "loading" : "idle",
    error: configurationError,
  };
  const [stored, setStored] = useState<StoredState>(initial);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let page: PositionPage | undefined;
    let positions: PositionPage["positions"] = [];
    setStored(initial);

    async function read(more: boolean) {
      if (cancelled || pending || !account || configurationError || (more && !page?.hasMore)) return;
      pending = true;
      const previous = page;
      const offset = more && previous ? previous.nextOffset : 0n;
      if (more) setStored(current => ({ ...current, isLoadingMore: true }));
      try {
        const next = await readPage(deployment, account, policy, offset, BigInt(pageSize), more ? previous?.snapshot : undefined);
        if (cancelled) return;
        if (next.positions.length > pageSize || next.nextOffset !== offset + BigInt(next.positions.length)
          || (next.hasMore && next.nextOffset <= offset)) {
          throw new Error("The position page did not advance correctly. Refresh to restart the scan.");
        }
        if (more && previous && (next.snapshot.blockNumber !== previous.snapshot.blockNumber
          || next.snapshot.blockHash.toLowerCase() !== previous.snapshot.blockHash.toLowerCase()
          || next.blockTimestamp !== previous.blockTimestamp)) {
          throw new Error("The position snapshot changed. Refresh to restart the scan.");
        }
        const combined = [...positions, ...next.positions];
        if (new Set(combined.map(item => item.id)).size !== combined.length) {
          throw new Error("The position page contains duplicate IDs. Refresh to restart the scan.");
        }
        positions = combined;
        page = next;
        setStored({
          scope, reader: readPage, status: "success", positions, snapshot: next.snapshot,
          blockTimestamp: next.blockTimestamp, hasMore: next.hasMore, isLoadingMore: false,
        });
      } catch (reason) {
        if (cancelled) return;
        // A continuation failure may indicate a reorg. Discard every page from that scan.
        page = undefined;
        positions = [];
        setStored({
          scope, reader: readPage, status: "error", positions, hasMore: false, isLoadingMore: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        pending = false;
      }
    }

    const controller: Scan = {
      scope, reader: readPage,
      cancel() { cancelled = true; },
      loadMore() { void read(true); },
    };
    scan.current = controller;
    void read(false);
    return () => {
      controller.cancel();
      if (scan.current === controller) scan.current = null;
    };
    // Every read input is represented by a primitive in scope; reader identity is separate.
  }, [scope, readPage]);

  const refresh = useCallback(() => {
    scan.current?.cancel();
    setRevision(value => value + 1);
  }, []);
  const loadMore = useCallback(() => {
    if (scan.current?.scope === scope && scan.current.reader === readPage) scan.current.loadMore();
  }, [scope, readPage]);

  // Hide an old account or policy result during render, before effect cleanup runs.
  const visible = stored.scope === scope && stored.reader === readPage ? stored : initial;
  const { scope: _scope, reader: _reader, ...state } = visible;
  return { ...state, refresh, loadMore };
}

export function EligibilityBadge({ eligible, className = "" }: { eligible: boolean | undefined; className?: string }) {
  return <span className={`cnv-eligibility ${className}`.trim()} data-eligible={eligible ?? "unknown"}>
    {eligible === undefined ? "Eligibility unknown" : eligible ? "Eligible (preview)" : "Not eligible (preview)"}
  </span>;
}

export interface ConvictionPositionsProps extends ConvictionPositionsOptions {
  /** Read decimals from the configured CONV token; never assume 18. */
  tokenDecimals: number;
  tokenSymbol?: string;
  className?: string;
}

function positionStatus(status: number, unlockAt: number, timestamp: bigint) {
  if (status === 1) return "Released";
  if (status === 2) return "Exited early";
  if (status !== 0) return "Unknown status";
  return BigInt(unlockAt) <= timestamp ? "Matured, awaiting release" : "Active";
}

function Timestamp({ value }: { value: bigint | number }) {
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return <>{value.toString()} Unix seconds</>;
  const iso = date.toISOString();
  return <time dateTime={iso}>{iso.replace("T", " ").replace(".000Z", " UTC")}</time>;
}

export function ConvictionPositions({ tokenDecimals, tokenSymbol = "CONV", className = "", ...options }: ConvictionPositionsProps) {
  const decimalsValid = Number.isInteger(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 255;
  const result = useConvictionPositions({ ...options, account: decimalsValid ? options.account : undefined });
  const { deployment, account, policy } = options;
  const eligibleCount = result.positions.filter(item => item.eligible).length;
  const minimumDays = policy.minimumRemainingSeconds / 86400n;
  const minimumDuration = policy.minimumRemainingSeconds % 86400n === 0n
    ? `${minimumDays} ${minimumDays === 1n ? "day" : "days"}`
    : `${policy.minimumRemainingSeconds} seconds`;

  return <section className={`cnv-positions ${className}`.trim()} aria-label="Conviction lock positions"
    aria-busy={result.status === "loading" || result.isLoadingMore}>
    <header className="cnv-positions-header"><h3>Lock positions</h3></header>
    {!decimalsValid ? <p className="cnv-error" role="alert">tokenDecimals must be an integer from 0 to 255.</p> : <>
      <p className="cnv-policy">
        Preview policy: at least {formatUnits(policy.minimumAmount, tokenDecimals)} {tokenSymbol},
        with at least {minimumDuration} remaining, active, and no early exit.
      </p>
      <p>Eligibility is a preview at the displayed snapshot. Recheck the policy and chain state before granting access.</p>
      <details className="cnv-read-context">
        <summary>Read details</summary>
        <dl className="cnv-context">
          <div><dt>Account</dt><dd>{account ?? "No account selected"}</dd></div>
          <div><dt>Chain</dt><dd>{deployment.chain.name} ({deployment.chain.id})</dd></div>
          <div><dt>Vault</dt><dd>{deployment.vaultAddress}</dd></div>
          <div><dt>CONV token</dt><dd>{deployment.convictionAddress}</dd></div>
          {result.snapshot && <div><dt>Block hash</dt><dd>{result.snapshot.blockHash}</dd></div>}
        </dl>
      </details>
      {result.status === "idle" && <p className="cnv-empty">Enter a wallet address to view positions. A wallet connection is not required.</p>}
      {result.status === "loading" && <p className="cnv-status" role="status">Loading positions...</p>}
      {result.status === "error" && <p className="cnv-error" role="alert">{result.error}</p>}
      {result.status === "success" && <>
        <p className="cnv-snapshot">Snapshot: block {result.snapshot!.blockNumber.toString()} at <Timestamp value={result.blockTimestamp!} />.</p>
        <p className="cnv-status" role="status">
          {result.positions.length === 0 ? "No positions found at this snapshot." :
            `${eligibleCount} of ${result.positions.length} loaded positions match the preview policy.`}
          {result.hasMore && " More positions remain. Load the next page to continue the scan."}
        </p>
        {result.positions.length > 0 && <ul className="cnv-position-list">
          {result.positions.map(({ id, position, eligible }) => {
            const isConv = position.token.toLowerCase() === deployment.convictionAddress.toLowerCase();
            return <li key={id.toString()} className="cnv-position">
              <div className="cnv-position-header"><h4>Position #{id.toString()}</h4><EligibilityBadge eligible={eligible} /></div>
              <p className="cnv-position-amount">{isConv ? `${formatUnits(position.amount, tokenDecimals)} ${tokenSymbol}` : `${position.amount} raw units (other token)`}</p>
              <dl className="cnv-position-details">
                <div><dt>Status</dt><dd>{positionStatus(position.status, position.unlockAt, result.blockTimestamp!)}</dd></div>
                {!isConv && <div><dt>Token</dt><dd>{position.token}</dd></div>}
                <div><dt>Unlock time</dt><dd><Timestamp value={position.unlockAt} /></dd></div>
                <div><dt>No early exit</dt><dd>{position.noEarlyExit ? "Yes" : "No"}</dd></div>
              </dl>
            </li>;
          })}
        </ul>}
      </>}
      <div className="cnv-actions">
        <button type="button" onClick={result.refresh} disabled={!account}>Refresh</button>
        {result.hasMore && <button type="button" onClick={result.loadMore} disabled={result.isLoadingMore}>
          {result.isLoadingMore ? "Loading more..." : "Load more"}
        </button>}
      </div>
    </>}
  </section>;
}
