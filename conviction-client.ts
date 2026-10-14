import {
  createPublicClient, getAddress, http, isAddressEqual, parseAbi, zeroAddress,
  type Chain, type ContractFunctionReturnType, type Hash, type PublicClient,
} from "viem";

// The documented vault interface includes noEarlyExit before amount.
export const convictionAbi = parseAbi([
  "function CONVICTION() view returns (address)",
  "function locksPaused() view returns (bool)",
  "function terms() view returns (uint40 minDuration, uint40 maxDuration, uint16 maxPenaltyBps, uint16 minPenaltyBps)",
  "function lockUntilMaturity(address token, uint256 amount, uint40 duration) returns (uint256 id)",
  "function positionCountOf(address account) view returns (uint256)",
  "function getPosition(uint256 id) view returns ((address owner, uint40 lockedAt, uint40 unlockAt, uint8 status, address token, uint16 maxPenaltyBps, uint16 minPenaltyBps, bool noEarlyExit, uint256 amount))",
  "function getPositionsOf(address account, uint256 offset, uint256 limit) view returns (uint256[] ids, (address owner, uint40 lockedAt, uint40 unlockAt, uint8 status, address token, uint16 maxPenaltyBps, uint16 minPenaltyBps, bool noEarlyExit, uint256 amount)[] list)",
  "event Locked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint40 unlockAt)",
]);

export type ConvictionPosition = ContractFunctionReturnType<typeof convictionAbi, "view", "getPosition">;

export interface LockSnapshot {
  blockNumber: bigint;
  blockHash: Hash;
}

/** Verify a snapshot after its reads; fail visibly rather than returning mixed-chain state. */
export async function assertCanonicalBlock(client: PublicClient, snapshot: LockSnapshot) {
  const current = await client.getBlock({ blockNumber: snapshot.blockNumber });
  if (!current.hash || current.hash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
    throw new Error("The snapshot block was reorganized. Refresh its receipt or restart the position scan.");
  }
}

export interface Deployment {
  chain: Chain;
  rpcUrl: string;
  vaultAddress: string;
  convictionAddress: string;
}

/** Check configuration consistency; this does not verify source code or establish contract safety. */
export async function connectConviction(deployment: Deployment) {
  const { chain, rpcUrl } = deployment;
  const vault = getAddress(deployment.vaultAddress);
  const conviction = getAddress(deployment.convictionAddress);
  if (!rpcUrl.trim() || vault === zeroAddress || conviction === zeroAddress) {
    throw new Error("Configure an explicit RPC, vault and CONV address.");
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  if (await publicClient.getChainId() !== chain.id) throw new Error("RPC is on the wrong chain.");
  const [vaultCode, tokenCode] = await Promise.all([
    publicClient.getCode({ address: vault }),
    publicClient.getCode({ address: conviction }),
  ]);
  if (!vaultCode || vaultCode === "0x" || !tokenCode || tokenCode === "0x") {
    throw new Error("The configured vault or CONV token has no deployed code.");
  }
  const actualToken = await publicClient.readContract({
    address: vault, abi: convictionAbi, functionName: "CONVICTION",
  });
  if (!isAddressEqual(actualToken, conviction)) throw new Error("Vault and CONV addresses do not match.");
  return { chain, vault, conviction, publicClient };
}
