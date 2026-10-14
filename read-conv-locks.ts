import { getAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import {
  assertCanonicalBlock, connectConviction, convictionAbi,
  type ConvictionPosition, type Deployment, type LockSnapshot,
} from "./conviction-client";

export interface LockPolicy {
  minimumAmount: bigint;
  minimumRemainingSeconds: bigint;
}

export function positionQualifies(
  position: ConvictionPosition,
  account: Address,
  conviction: Address,
  blockTimestamp: bigint,
  policy: LockPolicy,
): boolean {
  const unlockAt = BigInt(position.unlockAt);
  return account !== zeroAddress
    && policy.minimumAmount > 0n && policy.minimumRemainingSeconds > 0n
    && isAddressEqual(position.owner, account)
    && isAddressEqual(position.token, conviction)
    && position.status === 0 && position.noEarlyExit
    && position.amount >= policy.minimumAmount
    && unlockAt > blockTimestamp
    && unlockAt - blockTimestamp >= policy.minimumRemainingSeconds;
}

/** Read a bounded page. Pass the returned snapshot when continuing the same chain history. */
export async function readConvLocks(
  deployment: Deployment,
  accountAddress: string,
  policy: LockPolicy,
  offset = 0n,
  limit = 20n,
  snapshot?: LockSnapshot,
) {
  if (offset < 0n || limit < 1n || limit > 100n) throw new Error("Use a nonnegative offset and 1 to 100 entries.");
  const account = getAddress(accountAddress);
  const { publicClient, vault, conviction } = await connectConviction(deployment);
  const block = await publicClient.getBlock({ blockNumber: snapshot?.blockNumber });
  if (snapshot && block.hash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
    throw new Error("The snapshot block was reorganized. Restart the position scan.");
  }
  const [count, [ids, positions]] = await Promise.all([
    publicClient.readContract({
      address: vault, abi: convictionAbi, functionName: "positionCountOf", args: [account], blockNumber: block.number,
    }),
    publicClient.readContract({
      address: vault, abi: convictionAbi, functionName: "getPositionsOf", args: [account, offset, limit], blockNumber: block.number,
    }),
  ]);
  const currentSnapshot = { blockNumber: block.number, blockHash: block.hash };
  await assertCanonicalBlock(publicClient, currentSnapshot);
  const nextOffset = offset + BigInt(ids.length);
  return {
    snapshot: currentSnapshot,
    blockTimestamp: block.timestamp,
    nextOffset,
    hasMore: nextOffset < count,
    positions: positions.map((position, index) => ({
      id: ids[index],
      position,
      eligible: positionQualifies(position, account, conviction, block.timestamp, policy),
    })),
  };
}
