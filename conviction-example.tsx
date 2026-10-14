"use client";

import { useEffect, useState } from "react";
import { erc20Abi, parseUnits, type Address, type EIP1193Provider } from "viem";
import { connectConviction } from "./conviction-client";
import { deployment, sampleAccount } from "./conviction-deployment";
import { ConvictionPositions } from "./conviction-react";
import { ConvictionLockForm } from "./conviction-lock-form";
import "./conviction-components.css";

/** Pass the account and provider from your app's existing wallet connector. */
export function ConvictionExample({ account, provider }: {
  account?: Address;
  provider?: EIP1193Provider;
}) {
  const [decimals, setDecimals] = useState<number>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setError(undefined);
    setDecimals(undefined);
    async function load() {
      const { publicClient, conviction } = await connectConviction(deployment);
      const value = await publicClient.readContract({
        address: conviction, abi: erc20Abi, functionName: "decimals",
      });
      if (current) setDecimals(value);
    }
    void load().catch(reason => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { current = false; };
  }, [revision]);

  return <div className="cnv-example">
    {!account && <p>Showing the public sample wallet. Pass your connected account and provider to enable the lock form.</p>}
    {error ? <div role="alert">
      <p>{error}</p>
      <button type="button" onClick={() => setRevision(value => value + 1)}>Retry connection</button>
    </div> : decimals === undefined ? <p role="status">Checking the CONV token...</p> : <>
      <ConvictionPositions
        deployment={deployment}
        account={account ?? sampleAccount}
        tokenDecimals={decimals}
        tokenSymbol="CONV"
        policy={{ minimumAmount: parseUnits("1000", decimals), minimumRemainingSeconds: 30n * 86400n }}
      />
      <ConvictionLockForm deployment={deployment} account={account} provider={provider} />
    </>}
  </div>;
}
