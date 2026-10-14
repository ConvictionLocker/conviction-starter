# Conviction starter

Read public CONV locks, then run a browser example that creates a user-owned lock.
This starter includes TypeScript helpers, copyable React components and a plain HTML wallet example.
The source is available here; npm publishing is deferred.

## Run the starter

Use Node.js 24.x or Node.js 22.12+ within the 22.x release, npm and Git.

```sh
git clone --branch main --single-branch https://github.com/ConvictionLocker/conviction-starter.git
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

## React components

To have a coding agent handle the integration, copy [integration-prompt.md](integration-prompt.md) into the agent with your app open.
It covers the source files, wallet connection and verification steps.

```sh
npm run dev:react
```

Open the printed local URL at `/react.html` if your browser does not open automatically.
The React example reads the public sample wallet and renders a disconnected lock form.
It makes no wallet requests until you wire in your existing connector's account and EIP-1193 provider.

For an existing React app, install `viem@2`, then copy the component files and shared helpers into one folder such as `src/conviction/`:

```sh
mkdir -p ../your-app/src/conviction
cp conviction-*.ts conviction-*.tsx conviction-components.css create-conv-lock.ts read-conv-locks.ts ../your-app/src/conviction/
```

Replace `../your-app` with your app's path.
Use React 18 or 19, TypeScript with JSX enabled and an ES2020 or newer target.

```tsx
import { ConvictionExample } from "./conviction/conviction-example";

// Public read with a disconnected lock form.
<ConvictionExample />

// Reuse your existing wallet connection to enable locking.
<ConvictionExample account={account} provider={provider} />
```

Keep both props synchronized with your wallet connector.
For wagmi, use the EIP-1193 provider returned by `await connector.getProvider()`.
For Next.js App Router, render the example from a client component.
With Pages Router, move the CSS import from `conviction-example.tsx` into `pages/_app.tsx`.

| File | Exports or purpose |
| --- | --- |
| `conviction-example.tsx` | `ConvictionExample`, including a token decimals read. |
| `conviction-react.tsx` | `ConvictionPositions`, `useConvictionPositions`, `EligibilityBadge`. |
| `conviction-lock-form.tsx` | `ConvictionLockForm`, `ConvictionTransactionStatus`. |
| `conviction-lock-journal.ts` | IndexedDB attempt reservation and transaction storage. |
| `conviction-components.css` | Optional styles scoped to the components. |
| `conviction-styles.d.ts` | CSS import types for TypeScript. |

The position list includes loading, error, empty, refresh and pagination states.
Each page uses the same block snapshot; refresh starts a new scan.
Pass the token's actual decimals when using `ConvictionPositions` directly.

The React form reserves one attempt per account and vault before any wallet request.
The record blocks duplicate submissions across reloads and tabs on the same origin, including after failed checks or rejected prompts.
There is no automatic retry or reset.
Saved hashes remain available for receipt review, and unavailable storage prevents submission.
Before adding recovery, inspect wallet activity and receipts; a timeout does not prove a transaction failed.
The guard does not extend across devices or survive clearing browser storage.

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

For browser checks, run `npx playwright install chromium` once, then `npm test`.
The tests use local wallet and RPC fixtures without submitting transactions to a chain.

Run `npm run typecheck` to check TypeScript, or `npm run build` to check and build the browser page into `dist/`.
Use the React example above with your current wallet connector and build system.
Keep private RPC credentials on your server.

Continue with the [read quickstart](https://www.conviction.locker/docs/integrations#read-integration), [wallet integration guide](https://www.conviction.locker/docs/integrations#wallet-integration), or [Lockdrops implementation kit](https://www.conviction.locker/docs/lockdrop-integrations#lockdrop-setup).
