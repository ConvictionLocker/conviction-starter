import { getAddress, zeroAddress, type Address, type Hash } from "viem";
import type { Deployment } from "./conviction-client";

export interface LockAttempt {
  version: 1;
  key: string;
  id: string;
  chainId: number;
  vaultAddress: Address;
  tokenAddress: Address;
  account: Address;
  amount: string;
  durationSeconds: number;
  createdAt: number;
  status: "reserved" | "pending" | "confirmed" | "needs-review";
  transactions: { step: "reset-approval" | "approve" | "lock"; hash: Hash }[];
  positionId?: string;
  error?: string;
}

const databaseName = "conviction-react-lock-demo";
const storeName = "attempts";

export function lockAttemptKey(deployment: Pick<Deployment, "chain" | "vaultAddress">, account: string): string {
  const vault = getAddress(deployment.vaultAddress);
  const owner = getAddress(account);
  if (!Number.isSafeInteger(deployment.chain.id) || deployment.chain.id <= 0 || vault === zeroAddress || owner === zeroAddress) {
    throw new Error("Use a valid chain, vault and beneficiary.");
  }
  return `${deployment.chain.id}:${vault.toLowerCase()}:${owner.toLowerCase()}`;
}

function checkedAttempt(value: unknown): LockAttempt {
  if (!value || typeof value !== "object") throw new Error("The saved attempt cannot be read. Check wallet activity before continuing.");
  const record = value as LockAttempt;
  if (record.version !== 1 || typeof record.id !== "string" || !record.id
    || !Number.isFinite(record.createdAt) || !Number.isSafeInteger(record.durationSeconds) || record.durationSeconds <= 0
    || typeof record.amount !== "string" || !/^\d+(\.\d+)?$/.test(record.amount) || !/[1-9]/.test(record.amount)
    || !["reserved", "pending", "confirmed", "needs-review"].includes(record.status)
    || !Array.isArray(record.transactions)
    || record.transactions.some(item => !item || !["reset-approval", "approve", "lock"].includes(item.step) || !/^0x[0-9a-fA-F]{64}$/.test(item.hash))
    || (record.positionId !== undefined && !/^\d+$/.test(record.positionId))
    || (record.status === "confirmed" && (record.positionId === undefined || !record.transactions.some(item => item.step === "lock")))
    || (record.error !== undefined && typeof record.error !== "string")) {
    throw new Error("The saved attempt is invalid. Check wallet activity before continuing.");
  }
  const key = lockAttemptKey({ chain: { id: record.chainId } as Deployment["chain"], vaultAddress: record.vaultAddress }, record.account);
  if (record.key !== key || getAddress(record.tokenAddress) === zeroAddress) throw new Error("The saved attempt has an invalid deployment.");
  return record;
}

function openJournal(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is required to save the attempt before opening the wallet."));
    let failed = false;
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "key" });
    request.onerror = () => reject(request.error ?? new Error("Could not open the attempt journal."));
    request.onblocked = () => {
      failed = true;
      reject(new Error("The attempt journal is blocked by another tab. Close the other tab and reload."));
    };
    request.onsuccess = () => failed ? request.result.close() : resolve(request.result);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const db = await openJournal();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode, { durability: "strict" });
      let value: T;
      let failure: unknown;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("The attempt journal could not be saved."));
      const fail = (error: unknown) => { failure = error; transaction.abort(); };
      try { work(transaction.objectStore(storeName), result => { value = result; }, fail); }
      catch (error) { fail(error); }
    });
  } finally { db.close(); }
}

export function readLockAttempt(key: string): Promise<LockAttempt | null> {
  return transact("readonly", (store, result, fail) => {
    const request = store.get(key);
    request.onsuccess = () => {
      try { result(request.result === undefined ? null : checkedAttempt(request.result)); }
      catch (error) { fail(error); }
    };
  });
}

/** Atomic add across tabs. A reservation is never removed automatically. */
export function reserveLockAttempt(attempt: LockAttempt): Promise<boolean> {
  checkedAttempt(attempt);
  return transact("readwrite", (store, result) => {
    const request = store.add(attempt);
    request.onsuccess = () => result(true);
    request.onerror = event => {
      if (request.error?.name === "ConstraintError") {
        event.preventDefault();
        result(false);
      }
    };
  });
}

/** Only the owner of the reservation may update its recorded attempt. */
export function saveLockAttempt(attempt: LockAttempt): Promise<void> {
  checkedAttempt(attempt);
  return transact("readwrite", (store, result, fail) => {
    const request = store.get(attempt.key);
    request.onsuccess = () => {
      try {
        const current = checkedAttempt(request.result);
        if (current.id !== attempt.id) throw new Error("The attempt reservation changed. Check wallet activity before continuing.");
        store.put(attempt).onsuccess = () => result(undefined);
      } catch (error) { fail(error); }
    };
  });
}
