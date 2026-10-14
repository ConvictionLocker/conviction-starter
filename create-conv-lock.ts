import {
  createWalletClient, custom, erc20Abi, isAddressEqual, parseEventLogs, parseUnits,
  type Address, type EIP1193Provider, type Hash, type PublicClient, type TransactionReceipt,
} from "viem";
import { assertCanonicalBlock, connectConviction, convictionAbi, type Deployment } from "./conviction-client";

/** Reject excess precision: parseUnits alone can round it. */
export function parseLockAmount(input: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(input) || (input.split(".")[1]?.length ?? 0) > decimals) {
    throw new Error("Enter a decimal amount within the token's precision.");
  }
  const amount = parseUnits(input, decimals);
  if (amount <= 0n) throw new Error("Lock amount must be positive.");
  return amount;
}

/** Derive the ID from a confirmed event emitted by the configured vault, never nextId(). */
export function findCreatedPosition(
  receipt: Pick<TransactionReceipt, "status" | "logs">,
  vault: Address,
  account: Address,
  token: Address,
  amount: bigint,
): bigint {
  if (receipt.status !== "success") throw new Error("Lock transaction reverted.");
  const matches = parseEventLogs({
    abi: convictionAbi,
    eventName: "Locked",
    logs: receipt.logs.filter((log) => isAddressEqual(log.address, vault)),
  }).filter(({ args }) => isAddressEqual(args.owner, account)
    && isAddressEqual(args.token, token) && args.amount === amount);
  if (matches.length !== 1) throw new Error("Expected exactly one matching vault lock event.");
  return matches[0].args.id;
}

/** Read the created position on the receipt's chain before reporting a confirmed result. */
export async function readConfirmedPosition(
  publicClient: PublicClient,
  receipt: Pick<TransactionReceipt, "status" | "logs" | "blockNumber" | "blockHash">,
  vault: Address,
  account: Address,
  conviction: Address,
  amount: bigint,
) {
  const positionId = findCreatedPosition(receipt, vault, account, conviction, amount);
  const position = await publicClient.readContract({
    address: vault, abi: convictionAbi, functionName: "getPosition",
    args: [positionId], blockNumber: receipt.blockNumber,
  });
  await assertCanonicalBlock(publicClient, { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
  if (!isAddressEqual(position.owner, account) || !isAddressEqual(position.token, conviction)
    || position.amount !== amount || !position.noEarlyExit) {
    throw new Error("Confirmed position does not match the accepted lock.");
  }
  return { positionId, position };
}

type TransactionStep = "reset-approval" | "approve" | "lock";

/** Invoke from a user gesture after displaying the amount, duration and no-early-exit terms. */
export async function createConvLock(options: {
  deployment: Deployment;
  provider: EIP1193Provider;
  expectedAccount?: Address;
  amount: string;
  durationSeconds: number;
  onTransaction?: (step: TransactionStep, hash: Hash) => void;
}) {
  const { deployment, provider, durationSeconds } = options;
  const { chain, vault, conviction, publicClient } = await connectConviction(deployment);
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("Connect a wallet first.");
  if (options.expectedAccount && !isAddressEqual(account, options.expectedAccount)) {
    throw new Error("Connected wallet differs from the reviewed beneficiary. Connect and review again.");
  }

  async function checkWallet() {
    const [accounts, chainId] = await Promise.all([wallet.getAddresses(), wallet.getChainId()]);
    if (chainId !== chain.id) throw new Error(`Switch your wallet to ${chain.name}.`);
    if (!accounts[0] || !isAddressEqual(accounts[0], account)) {
      throw new Error("Wallet account changed. Review the lock again.");
    }
  }

  // Persist hashes in your app so a timeout can resume receipt lookup without sending twice.
  function report(step: TransactionStep, hash: Hash) {
    try { options.onTransaction?.(step, hash); } catch { /* UI errors must not interrupt receipt checks. */ }
  }

  async function confirm(step: TransactionStep, hash: Hash) {
    report(step, hash);
    let replacedWithDifferentAction = false;
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      onReplaced: ({ reason, transactionReceipt }) => {
        if (reason !== "repriced") replacedWithDifferentAction = true;
        report(step, transactionReceipt.transactionHash);
      },
    });
    if (replacedWithDifferentAction) throw new Error("Transaction cancelled or replaced. Review its receipt.");
    if (receipt.status !== "success") throw new Error(`${step} transaction reverted.`);
    return receipt;
  }

  await checkWallet();
  const [paused, terms, decimals] = await Promise.all([
    publicClient.readContract({ address: vault, abi: convictionAbi, functionName: "locksPaused" }),
    publicClient.readContract({ address: vault, abi: convictionAbi, functionName: "terms" }),
    publicClient.readContract({ address: conviction, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (paused) throw new Error("New locks are paused.");
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < terms[0] || durationSeconds > terms[1]) {
    throw new Error("Duration is outside the vault's current limits.");
  }
  const amount = parseLockAmount(options.amount, decimals);
  const allowance = () => publicClient.readContract({
    address: conviction, abi: erc20Abi, functionName: "allowance", args: [account, vault],
  });

  async function approve(value: bigint) {
    await checkWallet();
    const { request, result } = await publicClient.simulateContract({
      account, address: conviction, abi: erc20Abi, functionName: "approve", args: [vault, value],
    });
    if (!result) throw new Error("Token refused approval.");
    await checkWallet();
    await confirm(value === 0n ? "reset-approval" : "approve", await wallet.writeContract(request));
    if (await allowance() !== value) throw new Error("Confirmed allowance does not match the requested amount.");
  }

  const currentAllowance = await allowance();
  if (currentAllowance !== amount) {
    if (currentAllowance !== 0n) await approve(0n);
    await approve(amount);
  }
  await checkWallet();
  // Re-simulate after approval. Terms or pause state may have changed while the wallet was open.
  const { request } = await publicClient.simulateContract({
    account, address: vault, abi: convictionAbi, functionName: "lockUntilMaturity",
    args: [conviction, amount, durationSeconds],
  });
  await checkWallet();
  const receipt = await confirm("lock", await wallet.writeContract(request));
  const { positionId, position } = await readConfirmedPosition(publicClient, receipt, vault, account, conviction, amount);
  return { hash: receipt.transactionHash, positionId, position };
}
