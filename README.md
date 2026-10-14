# Conviction starter

Read public CONV locks, then run a browser example that creates a user-owned lock.
This starter contains TypeScript source helpers and a plain HTML page, not a published SDK or React component library.

## Run the starter

Use Node.js 24.x or Node.js 22.12+ within the 22.x release, npm and Git.

```sh
git clone --branch feat/standalone-starter --single-branch https://github.com/ConvictionLocker/conviction-starter.git
cd conviction-starter
npm ci
npm run read
npm run dev
```

The read command needs an internet connection but no wallet, API key or funds.
It prints the configured chain and vault, a block number, positions and `hasMore` for a public sample wallet.
Eligibility requires at least 1,000 CONV, at least 30 days remaining and no early exit.
Replace `sampleAccount` in `conviction-deployment.ts` to read another wallet.
The example returns the first page; continue with `page.nextOffset` and `page.snapshot` while `hasMore` is true, and restart if the snapshot block is replaced.
An eligibility preview does not authorize access; enforce the policy when the protected action occurs.

Open the local URL printed by Vite in a browser with an Ethereum wallet extension.
Switch to Robinhood Chain, chain ID 4663, and connect your wallet.
Review the displayed network, token, spender, beneficiary and lock terms before accepting and submitting.
Connecting alone sends no transaction.

## Real funds and security

The supplied browser example locks **1,000 CONV for 90 days on mainnet, with no early exit**.
It requires that amount of CONV plus ETH for gas, and can require separate approval and lock confirmations.
Principal cannot be unlocked before maturity under the contract rules.

Conviction has not been independently audited, and explorer source verification is pending.
The helpers check deployment consistency; they do not prove source equivalence or contract safety.
The vault is a shared security dependency, and an exploit could affect positions in that deployment.
Read the [security model](https://www.conviction.locker/docs/integrations#integration-risk) before submitting funds.

The browser demo records one attempt and blocks further attempts across reloads, including after a rejected prompt or failed check.
It does not implement production receipt recovery.
Inspect the saved transaction hashes and wallet activity before starting another attempt; a timeout does not prove failure.
For production use, add receipt recovery, account and chain change handling, explicit transaction states and duplicate-submission protection.

## Files and checks

| File | Purpose |
| --- | --- |
| `conviction-deployment.ts` | Public chain, vault, token and sample wallet configuration. |
| `conviction-client.ts` | Shared ABI and deployment checks. |
| `read-conv-locks.ts` | Bounded position reads and eligibility previews. |
| `read-conv-example.ts` | Command-line read example. |
| `create-conv-lock.ts` | Wallet approval, lock submission and receipt checks. |
| `index.html` | Browser interface and consent controls. |
| `main.ts` | Wallet connection, transaction status and attempt persistence. |

Run `npm run typecheck` to check TypeScript, or `npm run build` to check and build the browser page into `dist/`.
For an existing React app, reuse the source helpers with your current wallet connector's EIP-1193 provider and build system.
Keep private RPC credentials on your server.

Continue with the [read quickstart](https://www.conviction.locker/docs/integrations#read-integration), [wallet integration guide](https://www.conviction.locker/docs/integrations#wallet-integration), or [Lockdrops implementation kit](https://www.conviction.locker/docs/lockdrop-integrations#lockdrop-setup).
