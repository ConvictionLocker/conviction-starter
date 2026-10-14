"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { getAddress, type Address, type EIP1193Provider } from "viem";
import type { Deployment } from "./conviction-client";
import { createConvLock } from "./create-conv-lock";
import { lockAttemptKey, readLockAttempt, reserveLockAttempt, saveLockAttempt, type LockAttempt } from "./conviction-lock-journal";

export interface ConvictionLockFormProps {
  deployment: Deployment;
  provider?: EIP1193Provider;
  account?: Address;
  initialAmount?: string;
  initialDurationDays?: number;
  className?: string;
}

export interface ConvictionTransactionStatusProps {
  attempt: LockAttempt | null;
  error?: string | null;
  busy?: boolean;
  explorerUrl?: string;
  className?: string;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function transactionUrl(explorerUrl: string | undefined, hash: string): string | undefined {
  try {
    if (!explorerUrl || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return;
    const url = new URL(explorerUrl);
    if (url.protocol !== "https:" || url.username || url.password) return;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/tx/${hash}`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return; }
}

export function ConvictionTransactionStatus({ attempt, error, busy = false, explorerUrl, className = "" }: ConvictionTransactionStatusProps) {
  const id = useId();
  return <section className={`cnv-transaction-status ${className}`} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Transaction status</h3>
    <div role="status" aria-live="polite">
      {!attempt && !busy && !error && <p>No transaction submitted.</p>}
      {busy && <p>Checking the recorded attempt and waiting for wallet confirmations.</p>}
      {attempt && <>
        <p>{attempt.status === "confirmed" ? `Confirmed position #${attempt.positionId}.` : "An attempt is recorded for this account and vault. Automatic retries are disabled."}</p>
        <p>Beneficiary: <code>{attempt.account}</code><br />Chain: {attempt.chainId}<br />Vault: <code>{attempt.vaultAddress}</code></p>
        <p>Recorded terms: {attempt.amount} CONV for {attempt.durationSeconds / 86400} days. No early exit.<br />Token: <code>{attempt.tokenAddress}</code></p>
        {attempt.transactions.length > 0 ? <ul>
          {attempt.transactions.map(({ step, hash }) => {
            const url = transactionUrl(explorerUrl, hash);
            return <li key={`${step}:${hash}`}><span>{step}: </span>{url ? <a href={url} target="_blank" rel="noopener noreferrer"><code>{hash}</code><span> (opens explorer in a new tab)</span></a> : <code>{hash}</code>}</li>;
          })}
        </ul> : <p>No transaction hash was saved. Check your wallet for any submitted transaction.</p>}
      </>}
    </div>
    {error && <p className="cnv-error" role="alert">{error}</p>}
    {attempt && <p>Check the recorded transactions and wallet activity before another attempt. This example does not implement receipt recovery. A timeout does not prove failure.</p>}
  </section>;
}

/** One attempt per account and vault. The host app supplies the connected wallet. */
export function ConvictionLockForm({ deployment, provider, account, initialAmount = "1000", initialDurationDays = 90, className = "" }: ConvictionLockFormProps) {
  const id = useId();
  const [amount, setAmount] = useState(initialAmount);
  const [days, setDays] = useState(String(initialDurationDays));
  const [consent, setConsent] = useState<{ terms: string; provider: EIP1193Provider } | null>(null);
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<{ key: string | null; loaded: boolean; attempt: LockAttempt | null; error: string | null }>({ key: null, loaded: false, attempt: null, error: null });
  const mounted = useRef(false);
  const active = useRef<{ stopped: boolean } | null>(null);
  const submitting = useRef(false);
  let scopeKey: string | null = null;
  let configurationError: string | null = null;
  try { if (account) scopeKey = lockAttemptKey(deployment, account); }
  catch (error) { configurationError = message(error); }
  const durationSeconds = Number(days) * 24 * 60 * 60;
  const validTerms = /^\d+(\.\d+)?$/.test(amount) && /[1-9]/.test(amount)
    && /^\d+$/.test(days) && Number(days) > 0 && Number.isSafeInteger(durationSeconds);
  const terms = JSON.stringify([scopeKey, deployment.rpcUrl, deployment.convictionAddress, deployment.chain.name, amount, days]);
  const currentScope = useRef({ key: scopeKey, terms, provider });
  currentScope.current = { key: scopeKey, terms, provider };
  const currentJournal = journal.key === scopeKey ? journal : { loaded: false, attempt: null, error: null };
  const accepted = !!provider && consent?.provider === provider && consent.terms === terms;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (active.current) active.current.stopped = true; };
  }, []);
  useEffect(() => () => { if (active.current) active.current.stopped = true; }, [terms, provider]);
  useEffect(() => {
    if (!provider) return;
    const invalidate = () => { setConsent(null); if (active.current) active.current.stopped = true; };
    provider.on?.("accountsChanged", invalidate);
    provider.on?.("chainChanged", invalidate);
    provider.on?.("disconnect", invalidate);
    return () => {
      provider.removeListener?.("accountsChanged", invalidate);
      provider.removeListener?.("chainChanged", invalidate);
      provider.removeListener?.("disconnect", invalidate);
    };
  }, [provider]);
  useEffect(() => {
    let cancelled = false;
    setJournal({ key: scopeKey, loaded: false, attempt: null, error: null });
    if (!scopeKey) return;
    readLockAttempt(scopeKey).then(attempt => {
      if (!cancelled) setJournal({ key: scopeKey, loaded: true, attempt, error: attempt?.error ?? null });
    }).catch(error => {
      if (!cancelled) setJournal({ key: scopeKey, loaded: true, attempt: null, error: message(error) });
    });
    return () => { cancelled = true; };
  }, [scopeKey, provider]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !provider || !account || !scopeKey || !accepted || !validTerms
      || configurationError || !currentJournal.loaded || currentJournal.error || currentJournal.attempt) return;
    submitting.current = true;
    setBusy(true);
    const run = { stopped: false };
    active.current = run;
    const frozenDeployment = { ...deployment, chain: { ...deployment.chain } };
    const key = scopeKey;
    let attempt: LockAttempt | null = null;
    let reserved = false;
    let persistenceFailure: string | null = null;
    let persistence = Promise.resolve();
    const publish = (record: LockAttempt | null, error: string | null = null) => {
      if (mounted.current && currentScope.current.key === key) setJournal({ key, loaded: true, attempt: record, error });
    };
    const assertCurrent = () => {
      if (run.stopped || !mounted.current || currentScope.current.key !== key
        || currentScope.current.terms !== terms || currentScope.current.provider !== provider) {
        throw new Error("Wallet or accepted terms changed. This attempt remains recorded; check wallet activity before continuing.");
      }
    };
    try {
      attempt = {
        version: 1, key, id: crypto.randomUUID(), chainId: frozenDeployment.chain.id,
        vaultAddress: getAddress(frozenDeployment.vaultAddress), tokenAddress: getAddress(frozenDeployment.convictionAddress),
        account: getAddress(account), amount, durationSeconds, createdAt: Date.now(), status: "reserved", transactions: [],
      };
      assertCurrent();
      reserved = await reserveLockAttempt(attempt);
      if (!reserved) {
        const existing = await readLockAttempt(key);
        publish(existing, "An attempt is already recorded in this browser. Check its transactions before continuing.");
        return;
      }
      publish(attempt);
      const guardedProvider: EIP1193Provider = {
        on: (eventName, listener) => provider.on(eventName, listener),
        removeListener: (eventName, listener) => provider.removeListener(eventName, listener),
        request: async request => {
          // Hash callbacks are synchronous. This barrier stops later wallet writes until each save completes.
          await persistence;
          if (persistenceFailure) throw new Error(persistenceFailure);
          assertCurrent();
          const saved = await readLockAttempt(key);
          if (saved?.id !== attempt?.id) throw new Error("The saved attempt changed. No further wallet action will be requested.");
          assertCurrent();
          return provider.request(request as Parameters<EIP1193Provider["request"]>[0]);
        },
      };
      const result = await createConvLock({
        deployment: frozenDeployment, provider: guardedProvider, expectedAccount: attempt.account, amount, durationSeconds,
        onTransaction(step, hash) {
          if (!attempt) return;
          const transactions = attempt.transactions.some(item => item.step === step && item.hash === hash)
            ? attempt.transactions : [...attempt.transactions, { step, hash }];
          attempt = { ...attempt, status: "pending", transactions };
          const record = attempt;
          publish(record);
          persistence = persistence.then(() => saveLockAttempt(record)).catch(error => {
            persistenceFailure = `Could not save a transaction hash: ${message(error)}. Check your wallet; this attempt remains blocked.`;
          });
        },
      });
      await persistence;
      if (persistenceFailure) throw new Error(persistenceFailure);
      attempt = { ...attempt, status: "confirmed", positionId: result.positionId.toString() };
      await saveLockAttempt(attempt);
      publish(attempt);
    } catch (error) {
      await persistence;
      let detail = persistenceFailure ?? message(error);
      if (reserved && attempt) {
        attempt = { ...attempt, status: "needs-review", error: detail };
        try { await saveLockAttempt(attempt); }
        catch (saveError) { detail += ` The journal could not be updated: ${message(saveError)}.`; }
        publish(attempt, detail);
      } else {
        publish(null, detail);
      }
    } finally {
      submitting.current = false;
      if (active.current === run) active.current = null;
      if (mounted.current) { setBusy(false); setConsent(null); }
    }
  }

  const disabled = busy || !provider || !account || !scopeKey || !accepted || !validTerms || !!configurationError
    || !currentJournal.loaded || !!currentJournal.error || !!currentJournal.attempt;
  return <form className={`cnv-lock-form ${className}`} onSubmit={submit} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Create a CONV lock</h3>
    <p>Real mainnet funds. Principal cannot be withdrawn before maturity. Contracts are unaudited and explorer source verification is pending.</p>
    <div className="cnv-lock-fields">
      <label htmlFor={`${id}-amount`}>Amount (CONV)<input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy || !!currentJournal.attempt} required /></label>
      <label htmlFor={`${id}-days`}>Duration (days)<input id={`${id}-days`} type="number" min="1" step="1" value={days} onChange={event => setDays(event.target.value)} disabled={busy || !!currentJournal.attempt} required /></label>
    </div>
    <dl className="cnv-lock-details">
      <div><dt>Network</dt><dd>{deployment.chain.name} (chain {deployment.chain.id})</dd></div>
      <div><dt>Token</dt><dd><code>{deployment.convictionAddress}</code></dd></div>
      <div><dt>Vault and approval spender</dt><dd><code>{deployment.vaultAddress}</code></dd></div>
      <div><dt>Beneficiary</dt><dd>{account ? <code>{account}</code> : "Not connected"}</dd></div>
      <div><dt>Exit mode</dt><dd>No early exit</dd></div>
    </dl>
    <p>Approval and locking can require separate wallet confirmations. ETH is required for network fees.</p>
    {!provider || !account ? <p>Connect a wallet in your app to continue.</p> : !currentJournal.loaded && <p role="status">Checking for a previous attempt...</p>}
    {!validTerms && <p className="cnv-error" role="alert">Enter a positive CONV amount and a whole number of days.</p>}
    <label className="cnv-lock-consent"><input type="checkbox" checked={accepted} onChange={event => setConsent(event.target.checked && provider ? { terms, provider } : null)} disabled={busy || !provider || !account || !!currentJournal.attempt} />I accept that this CONV cannot be withdrawn before maturity.</label>
    <button className="cnv-lock-submit" type="submit" disabled={disabled}>{busy ? "Waiting for wallet and receipts..." : "Approve and lock CONV"}</button>
    <p className="cnv-lock-boundary">This example allows one attempt per account and vault in this browser. Attempts remain recorded after rejected prompts, failures and reloads. It never retries automatically.</p>
    <ConvictionTransactionStatus attempt={currentJournal.attempt} error={configurationError ?? currentJournal.error} busy={busy || (!!account && !currentJournal.loaded)} explorerUrl={deployment.chain.blockExplorers?.default.url} />
  </form>;
}
