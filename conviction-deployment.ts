import { defineChain } from "viem";
import type { Deployment } from "./conviction-client";

// Public mainnet configuration. Unaudited; explorer source verification is pending.
const rpcUrl = "https://rpc.mainnet.chain.robinhood.com";
const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "RobinScan", url: "https://robin.etherscan.io" } },
});

export const deployment: Deployment = {
  chain,
  rpcUrl,
  vaultAddress: "0x71d80F63E3Df575b64d7F3f2c7A7b4BF7443659A",
  convictionAddress: "0xB6ff957E31286F748989Cbf69183b1b5e8d921A8",
};

// Public owner of example position #3. Replace with an address you want to read.
export const sampleAccount = "0xE6eA861295af4e0d0D7F331c7B950f7DA3A9D265";
