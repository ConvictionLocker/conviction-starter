import { erc20Abi, formatUnits, parseUnits } from "viem";
import process from "node:process";
import { connectConviction } from "./conviction-client";
import { deployment, sampleAccount } from "./conviction-deployment";
import { readConvLocks } from "./read-conv-locks";

async function main() {
  const { publicClient, conviction } = await connectConviction(deployment);
  const decimals = await publicClient.readContract({
    address: conviction, abi: erc20Abi, functionName: "decimals",
  });
  const page = await readConvLocks(deployment, sampleAccount, {
    minimumAmount: parseUnits("1000", decimals),
    minimumRemainingSeconds: 30n * 24n * 60n * 60n,
  });
  console.log(JSON.stringify({
    chainId: deployment.chain.id,
    vault: deployment.vaultAddress,
    blockNumber: page.snapshot.blockNumber.toString(),
    positions: page.positions.map(({ id, position, eligible }) => ({
      id: id.toString(), amount: formatUnits(position.amount, decimals),
      noEarlyExit: position.noEarlyExit, eligible,
    })),
    hasMore: page.hasMore,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
