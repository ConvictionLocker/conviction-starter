# Conviction React integration prompt

Integrate the Conviction React examples into this existing app.
Inspect its framework, router, package manager, build settings, wallet connection and styling before changing files.
Preserve its architecture and visual conventions.

Read the [integration guide](https://www.conviction.locker/docs/integrations#integration-onboarding).
Use the [ConvictionLocker/conviction-starter React examples](https://github.com/ConvictionLocker/conviction-starter/tree/feat/react-components) on branch `feat/react-components`, currently under pull request review to `main`.
Do not replace this app's package or build configuration with the starter's.

The examples require React 18 or 19, TypeScript with JSX, an ES2020 or newer target, and viem 2.
Check installed versions first; if needed, use `npm install viem@2` or the existing package manager's equivalent.
There is no published Conviction npm SDK.

Copy these ten files together into a suitable app directory, preserving sibling imports:

```text
conviction-example.tsx
conviction-react.tsx
conviction-lock-form.tsx
conviction-lock-journal.ts
conviction-components.css
conviction-styles.d.ts
conviction-deployment.ts
conviction-client.ts
read-conv-locks.ts
create-conv-lock.ts
```

Start with `<ConvictionExample />`: it reads the public sample account and keeps locking disabled.
Keep token decimals read from the configured token rather than assuming 18.
Then pass the app's existing account and EIP-1193 provider as `<ConvictionExample account={account} provider={provider} />`.
Keep them synchronized with wallet changes; do not add another wallet or query provider.
If a required deployment or wallet choice is missing, ask before inventing it.
Never invent addresses, keys, credentials or licensing terms.

For Next.js App Router, render from a client component.
For Pages Router, move the example's CSS import into `pages/_app.tsx`.
Adapt the scoped styles to this app without changing unrelated screens.

Keep eligibility labelled as a snapshot preview; enforce access policy again when access is used.
Preserve disclosure that the supplied deployment uses real mainnet funds, no early exit and unaudited contracts.
Retain the journal and wallet checks: unavailable storage blocks submission, recorded attempts remain blocked after failures or reloads, and neither automatic retries nor clearing attempts is permitted.

Run type checks, the app build and browser checks for loading, errors, pagination, refresh and wallet changes.
Test wallet actions with mocks only; never send real transactions.
Report the changed files, verification results and any remaining limitations.
