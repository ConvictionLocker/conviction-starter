import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider } from "viem";
import { createConvLock } from "./create-conv-lock";
import { deployment } from "./conviction-deployment";

// For a wallet connector, use its EIP-1193 provider instead of window.ethereum.
const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const lockButton = document.querySelector<HTMLButtonElement>("#lock")!;
const consent = document.querySelector<HTMLInputElement>("#accept")!;
const beneficiary = document.querySelector<HTMLElement>("#beneficiary")!;
const status = document.querySelector<HTMLElement>("#status")!;
const journalKey = `conviction-demo:${deployment.chain.id}:${deployment.vaultAddress}`;
let account: Address | undefined;
let busy = false;

document.querySelector<HTMLElement>("#network")!.textContent = deployment.chain.name;
document.querySelector<HTMLElement>("#spender")!.textContent = deployment.vaultAddress;
document.querySelector<HTMLElement>("#token")!.textContent = deployment.convictionAddress;

function updateButton() {
  // A submitted attempt stays blocked across reloads, including after a timeout.
  lockButton.disabled = busy || !account || !consent.checked || localStorage.getItem(journalKey) !== null;
}

const saved = localStorage.getItem(journalKey);
if (saved) status.textContent = `Recorded attempt: ${saved}\nCheck the transaction on RobinScan before starting another lock. This demo does not retry submitted attempts.`;
consent.addEventListener("change", updateButton);

connectButton.addEventListener("click", async () => {
  consent.checked = false;
  account = undefined;
  beneficiary.textContent = "Not connected";
  updateButton();
  try {
    if (!provider) throw new Error("Open this page in a browser with an Ethereum wallet extension.");
    const wallet = createWalletClient({ transport: custom(provider) });
    const [selected] = await wallet.requestAddresses();
    if (!selected) throw new Error("No wallet account selected.");
    if (await wallet.getChainId() !== deployment.chain.id) {
      throw new Error(`Switch your wallet to ${deployment.chain.name} (chain ${deployment.chain.id}), then connect again.`);
    }
    account = getAddress(selected);
    beneficiary.textContent = account;
    if (!localStorage.getItem(journalKey)) status.textContent = "Review the beneficiary and lock terms, then accept to continue.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  updateButton();
});

lockButton.addEventListener("click", async () => {
  if (!provider || !account || !consent.checked || busy || localStorage.getItem(journalKey)) return;
  busy = true;
  connectButton.disabled = true;
  updateButton();
  // Write before any wallet action so even a reload before receiving a hash blocks retries.
  try {
    localStorage.setItem(journalKey, "Started; check your wallet if no transaction hash is shown.");
    status.textContent = "Checking the wallet and current terms. Follow the approval and lock prompts in your wallet.";
    const lock = await createConvLock({
      deployment, provider, expectedAccount: account,
      amount: "1000", durationSeconds: 90 * 24 * 60 * 60,
      onTransaction(step, hash) {
        localStorage.setItem(journalKey, `${step}: ${hash}`);
        status.textContent = `${step} submitted: ${hash}\nWaiting for confirmation. Do not submit again.`;
      },
    });
    localStorage.setItem(journalKey, `Confirmed position ${lock.positionId}: ${lock.hash}`);
    status.textContent = `Confirmed position #${lock.positionId}\nBeneficiary: ${lock.position.owner}\nTransaction: ${lock.hash}`;
  } catch (error) {
    status.textContent = `${error instanceof Error ? error.message : String(error)}\nRecorded attempt: ${localStorage.getItem(journalKey) ?? "No transaction recorded"}\nCheck your wallet and RobinScan. A timeout does not mean a transaction failed.`;
  } finally {
    busy = false;
    connectButton.disabled = false;
    consent.checked = false;
    updateButton();
  }
});

updateButton();
