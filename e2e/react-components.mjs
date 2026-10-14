// Run the guide's copied React sources in an independent browser app, without a wallet or live RPC.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, erc20Abi, parseAbi } from "viem";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const sources = ["conviction-client.ts", "read-conv-locks.ts", "create-conv-lock.ts", "conviction-react.tsx", "conviction-lock-form.tsx", "conviction-lock-journal.ts"];
const account = "0x2222222222222222222222222222222222222222";
const otherAccount = "0x4444444444444444444444444444444444444444";
const vault = "0x1111111111111111111111111111111111111111";
const token = "0x3333333333333333333333333333333333333333";
const blockHash = `0x${"aa".repeat(32)}`;
const fixtureAbi = parseAbi([
  "function CONVICTION() view returns (address)",
  "function locksPaused() view returns (bool)",
  "function terms() view returns (uint40,uint40,uint16,uint16)",
  "function lockUntilMaturity(address token,uint256 amount,uint40 duration) returns (uint256)",
  "function getPosition(uint256 id) view returns ((address owner,uint40 lockedAt,uint40 unlockAt,uint8 status,address token,uint16 maxPenaltyBps,uint16 minPenaltyBps,bool noEarlyExit,uint256 amount))",
  "event Locked(uint256 indexed id,address indexed owner,address indexed token,uint256 amount,uint40 unlockAt)",
]);
const fixturePosition = { owner: account, lockedAt: 1000, unlockAt: 7_777_000, status: 0, token, maxPenaltyBps: 0, minPenaltyBps: 0, noEarlyExit: true, amount: 1_000_000_000n };
const sessions = new Map();
const session = key => {
  if (!sessions.has(key)) sessions.set(key, { allowance: 0n, sends: [] });
  return sessions.get(key);
};
const block = { number: "0x64", timestamp: "0x3e8", hash: blockHash, parentHash: blockHash, nonce: "0x0000000000000000", gasLimit: "0x1c9c380", gasUsed: "0x0", size: "0x100", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", transactions: [], uncles: [] };
function rpcResult(request, state) {
  const { method, params = [] } = request;
  if (method === "eth_chainId") return "0x7a69";
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_blockNumber") return "0x64";
  if (method === "eth_getBlockByNumber") return block;
  if (method === "eth_call") {
    const abi = params[0].to.toLowerCase() === token ? erc20Abi : fixtureAbi;
    const { functionName } = decodeFunctionData({ abi, data: params[0].data });
    const values = { CONVICTION: token, locksPaused: false, terms: [1, 315_360_000, 0, 0], decimals: 6, allowance: state.allowance, approve: true, lockUntilMaturity: 42n, getPosition: fixturePosition };
    assert(functionName in values, `Unexpected contract read: ${functionName}`);
    return encodeFunctionResult({ abi, functionName, result: values[functionName] });
  }
  if (method === "eth_getTransactionReceipt") {
    const send = state.sends.find(item => item.hash === params[0]);
    if (!send) return null;
    const log = { address: vault, blockHash, blockNumber: "0x64", transactionHash: send.hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
      topics: encodeEventTopics({ abi: fixtureAbi, eventName: "Locked", args: { id: 42n, owner: account, token } }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint40" }], [fixturePosition.amount, fixturePosition.unlockAt]) };
    return { blockHash, blockNumber: "0x64", contractAddress: null, cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", from: account, gasUsed: "0x5208", logs: send.kind === "lockUntilMaturity" ? [log] : [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", to: send.to, transactionHash: send.hash, transactionIndex: "0x0", type: "0x2" };
  }
  throw new Error(`Unexpected RPC method: ${method}`);
}

const harness = String.raw`
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ConvictionPositions, useConvictionPositions } from "./conviction-react";
import { ConvictionLockForm } from "./conviction-lock-form";
import { lockAttemptKey, readLockAttempt, reserveLockAttempt, saveLockAttempt } from "./conviction-lock-journal";

const w = window as any;
const accountA = "0x2222222222222222222222222222222222222222";
const accountB = "0x4444444444444444444444444444444444444444";
const params = new URLSearchParams(location.search);
const caseId = params.get("case") || "default";
const rpcUrl = location.origin + "/rpc?case=" + encodeURIComponent(caseId);
const deployment = { chain: { id: 31337, name: "Fixture", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }, rpcUrl, vaultAddress: "0x1111111111111111111111111111111111111111", convictionAddress: "0x3333333333333333333333333333333333333333" };
const stringify = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const pending = new Map();
const fixture: any = { calls: [], frames: [], walletRequests: [], sends: [], deployment, accountA, accountB, journal: { lockAttemptKey, readLockAttempt, reserveLockAttempt, saveLockAttempt } };
w.fixture = fixture;
const readPage = (...args: any[]) => {
  const id = fixture.calls.length;
  fixture.calls.push({ id, account: args[1], policy: args[2], offset: args[3], limit: args[4], snapshot: args[5] });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
fixture.resolveRead = (id: number, data: any = {}) => {
  const call = fixture.calls[id];
  const ids = data.ids || [];
  pending.get(id).resolve({ snapshot: { blockNumber: 100n, blockHash: "0x" + "aa".repeat(32) }, blockTimestamp: 1000n,
    positions: ids.map((value: string) => ({ id: BigInt(value), position: { owner: call.account, lockedAt: 900, unlockAt: 100000, status: 0, token: data.otherTokenIds?.includes(value) ? "0x5555555555555555555555555555555555555555" : deployment.convictionAddress, maxPenaltyBps: 0, minPenaltyBps: 0, noEarlyExit: true, amount: 1000000000n }, eligible: data.eligible ?? true })),
    nextOffset: BigInt(call.offset || 0) + BigInt(ids.length), hasMore: data.hasMore ?? false });
  pending.delete(id);
};
fixture.rejectRead = (id: number, message = "Fixture read failed") => { pending.get(id).reject(new Error(message)); pending.delete(id); };
fixture.makeAttempt = (id: string, account = accountA) => ({ version: 1, key: lockAttemptKey(deployment, account), id, chainId: deployment.chain.id,
  vaultAddress: deployment.vaultAddress, tokenAddress: deployment.convictionAddress, account, amount: "1000", durationSeconds: 7776000,
  createdAt: Date.now(), status: "reserved", transactions: [] });
fixture.snapshotCalls = () => JSON.parse(stringify(fixture.calls));
let releaseRequest: undefined | (() => void);
fixture.releaseWallet = () => releaseRequest?.();
const walletListeners = new Map<string, Set<(...args: any[]) => void>>();
fixture.emitWallet = (event: string, value: unknown) => walletListeners.get(event)?.forEach(listener => listener(value));
const provider = {
  on(event: string, listener: (...args: any[]) => void) {
    if (!walletListeners.has(event)) walletListeners.set(event, new Set());
    walletListeners.get(event)!.add(listener);
  },
  removeListener(event: string, listener: (...args: any[]) => void) { walletListeners.get(event)?.delete(listener); },
  async request({ method, params: values }: any) {
    fixture.walletRequests.push(method);
    if (method === "eth_requestAccounts") {
      if (params.get("holdWallet") === "1") await new Promise<void>(resolve => { releaseRequest = resolve; });
      return [accountA];
    }
    if (method === "eth_accounts") return [accountA];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_sendTransaction") {
      fixture.sends.push(values[0]);
      const response = await fetch("/wallet-send?case=" + encodeURIComponent(caseId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values[0]) });
      return (await response.json()).hash;
    }
    throw new Error("Unexpected wallet method: " + method);
  },
};
function Probe({ options, account }: any) {
  const value = useConvictionPositions(options);
  useLayoutEffect(() => { fixture.frames.push({ account, ...JSON.parse(stringify(value)) }); });
  return <section aria-label="Read probe"><output id="state">{stringify({ account, ...value })}</output>
    <button onClick={value.refresh}>Refresh positions</button><button onClick={value.loadMore}>Load next page</button></section>;
}
function ReadApp() {
  const [account, setAccount] = useState<any>(accountA);
  const [minimumAmount, setMinimum] = useState(100n);
  const [revision, setRevision] = useState(0);
  fixture.changeAccount = (next: string | undefined) => flushSync(() => setAccount(next));
  fixture.changePolicy = (next: string) => flushSync(() => setMinimum(BigInt(next)));
  fixture.rerender = () => flushSync(() => setRevision(value => value + 1));
  const options = { deployment: { ...deployment, chain: { ...deployment.chain } }, account, policy: { minimumAmount, minimumRemainingSeconds: 60n }, pageSize: params.get("mode") === "component" ? 2 : 1, readPage };
  return <><output id="revision">{revision}</output>{params.get("mode") === "component"
    ? <ConvictionPositions {...options} tokenDecimals={6} tokenSymbol="CONV" />
    : <Probe options={options} account={account} />}</>;
}
function FormApp() {
  const [mounted, setMounted] = useState(true);
  fixture.unmountForm = () => flushSync(() => setMounted(false));
  return mounted ? <ConvictionLockForm deployment={deployment} provider={params.get("disconnected") === "1" ? undefined : provider}
    account={params.get("disconnected") === "1" ? undefined : accountA} /> : <p>Form unmounted</p>;
}
const mode = params.get("mode") || "hook";
createRoot(document.getElementById("root")!).render(<StrictMode>{mode === "journal" ? <p>Journal ready</p> : mode === "form" ? <FormApp /> : <ReadApp />}</StrictMode>);
`;

const directory = await mkdtemp(join(tmpdir(), "conviction-react-browser-"));
let server;
let browser;
const errors = [];
try {
  for (const name of sources) await writeFile(join(directory, name), await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
  await writeFile(join(directory, "entry.tsx"), harness);
  const bundled = await build({ entryPoints: [join(directory, "entry.tsx")], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  const script = bundled.outputFiles[0].text;
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/bundle.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return; }
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        const state = session(url.searchParams.get("case"));
        response.writeHead(200, { "content-type": "application/json" });
        if (url.pathname === "/wallet-send") {
          const abi = input.to.toLowerCase() === token ? erc20Abi : fixtureAbi;
          const decoded = decodeFunctionData({ abi, data: input.data });
          if (decoded.functionName === "approve") state.allowance = decoded.args[1];
          const hash = `0x${String(state.sends.length + 1).padStart(64, "0")}`;
          state.sends.push({ hash, kind: decoded.functionName, to: input.to });
          response.end(JSON.stringify({ hash }));
        } else {
          assert.equal(url.pathname, "/rpc", "Only the local fixture RPC may receive calls");
          const respond = item => ({ jsonrpc: "2.0", id: item.id, result: rpcResult(item, state) });
          response.end(JSON.stringify(Array.isArray(input) ? input.map(respond) : respond(input)));
        }
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main><script type="module" src="/bundle.js"></script></body></html>');
    } catch (error) {
      errors.push(`Fixture server: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: -32603, message: error.message } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext();
  const open = async (query, browserContext = context) => {
    const page = await browserContext.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${base}/?${query}`);
    await page.waitForFunction(() => !!window.fixture);
    return page;
  };
  const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const calls = page => page.evaluate(() => window.fixture.snapshotCalls());
  const newest = async page => (await calls(page)).at(-1);
  const state = page => page.locator("#state").evaluate(element => JSON.parse(element.textContent));
  const waitState = (page, status) => page.waitForFunction(expected => JSON.parse(document.getElementById("state").textContent).status === expected, status);
  const resolveRead = (page, id, data) => page.evaluate(({ id, data }) => window.fixture.resolveRead(id, data), { id, data });
  const waitCalls = (page, count) => page.waitForFunction(expected => window.fixture.calls.length >= expected, count);

  const reads = await open("mode=hook");
  await waitState(reads, "loading");
  await settle(reads);
  const initialCalls = await calls(reads);
  assert.equal((await state(reads)).positions.length, 0);
  await resolveRead(reads, initialCalls.at(-1).id, { ids: ["1"], hasMore: true, eligible: false });
  await waitState(reads, "success");
  assert.equal((await state(reads)).hasMore, true);
  await reads.evaluate(() => window.fixture.rerender());
  await settle(reads);
  assert.equal((await calls(reads)).length, initialCalls.length, "Equivalent object props must not restart reads");
  await reads.getByRole("button", { name: "Load next page", exact: true }).evaluate(button => { button.click(); button.click(); });
  await waitCalls(reads, initialCalls.length + 1);
  await settle(reads);
  const continuation = await newest(reads);
  assert.equal((await calls(reads)).length, initialCalls.length + 1, "Repeated load clicks must share one request");
  assert.deepEqual(continuation.snapshot, { blockNumber: "100", blockHash });
  assert.equal(continuation.offset, "1");
  await resolveRead(reads, continuation.id, { ids: ["2"], hasMore: true });
  await reads.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).positions.length === 2);
  assert.deepEqual((await state(reads)).positions.map(item => item.id), ["1", "2"]);

  await reads.getByRole("button", { name: "Load next page", exact: true }).click();
  await reads.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).isLoadingMore);
  const beforeSwitch = await newest(reads);
  await reads.evaluate(value => window.fixture.changeAccount(value), otherAccount);
  await waitCalls(reads, beforeSwitch.id + 2);
  assert.equal((await state(reads)).positions.length, 0, "Changing accounts must clear the previous account immediately");
  const newOwnerRead = await newest(reads);
  await resolveRead(reads, newOwnerRead.id, { ids: ["22"] });
  await waitState(reads, "success");
  await resolveRead(reads, beforeSwitch.id, { ids: ["999"] });
  for (const call of initialCalls.slice(0, -1)) await resolveRead(reads, call.id, { ids: ["998"] });
  await settle(reads);
  assert.deepEqual((await state(reads)).positions.map(item => item.id), ["22"], "Late old-account or StrictMode reads must not replace current results");

  await reads.getByRole("button", { name: "Refresh positions", exact: true }).click();
  await waitState(reads, "loading");
  const oldPolicyRead = await newest(reads);
  await reads.evaluate(() => window.fixture.changePolicy("200"));
  await waitCalls(reads, oldPolicyRead.id + 2);
  await resolveRead(reads, (await newest(reads)).id, { ids: ["23"] });
  await waitState(reads, "success");
  await resolveRead(reads, oldPolicyRead.id, { ids: ["996"] });
  await settle(reads);
  assert.deepEqual((await state(reads)).positions.map(item => item.id), ["23"], "A response for the previous eligibility policy must not appear");

  await reads.getByRole("button", { name: "Refresh positions", exact: true }).click();
  await waitState(reads, "loading");
  const staleRefresh = await newest(reads);
  await reads.getByRole("button", { name: "Refresh positions", exact: true }).click();
  await waitCalls(reads, staleRefresh.id + 2);
  await resolveRead(reads, (await newest(reads)).id, { ids: [] });
  await waitState(reads, "success");
  await resolveRead(reads, staleRefresh.id, { ids: ["997"] });
  await settle(reads);
  assert.deepEqual((await state(reads)).positions, [], "A superseded refresh must not replace an empty result");

  await reads.getByRole("button", { name: "Refresh positions", exact: true }).click();
  await waitState(reads, "loading");
  await resolveRead(reads, (await newest(reads)).id, { ids: ["3"], hasMore: true });
  await waitState(reads, "success");
  await reads.getByRole("button", { name: "Load next page", exact: true }).click();
  await reads.waitForFunction(() => JSON.parse(document.getElementById("state").textContent).isLoadingMore);
  await reads.evaluate(id => window.fixture.rejectRead(id, "Fixture page two failed"), (await newest(reads)).id);
  await waitState(reads, "error");
  assert.deepEqual((await state(reads)).positions, [], "A failed continuation must discard the incomplete snapshot");
  assert.match((await state(reads)).error, /Fixture page two failed/);
  await reads.getByRole("button", { name: "Refresh positions", exact: true }).click();
  await waitState(reads, "loading");
  assert.equal((await newest(reads)).offset, "0");
  assert.equal((await newest(reads)).snapshot, undefined);
  await resolveRead(reads, (await newest(reads)).id, { ids: [] });
  await waitState(reads, "success");
  await reads.evaluate(() => window.fixture.changeAccount(undefined));
  await waitState(reads, "idle");
  assert.deepEqual((await state(reads)).positions, []);
  assert(await reads.evaluate(() => window.fixture.frames.every(frame => frame.positions.every(item => item.position.owner === frame.account))), "No committed render may display a position for the previous account, including before effect cleanup");
  await reads.close();

  const component = await open("mode=component");
  await component.getByText("Loading positions...", { exact: true }).waitFor();
  await waitCalls(component, 1);
  await settle(component);
  await resolveRead(component, (await newest(component)).id, { ids: ["1", "2"], otherTokenIds: ["2"], hasMore: true, eligible: false });
  const convPosition = component.getByRole("listitem").filter({ has: component.getByRole("heading", { name: "Position #1", exact: true }) });
  const otherPosition = component.getByRole("listitem").filter({ has: component.getByRole("heading", { name: "Position #2", exact: true }) });
  await convPosition.getByText("1000 CONV", { exact: true }).waitFor();
  await otherPosition.getByText("1000000000 raw units (other token)", { exact: true }).waitFor();
  assert.doesNotMatch(await otherPosition.innerText(), /1000 CONV/);
  await component.getByText("0 of 2 loaded positions match the preview policy.", { exact: false }).waitFor();
  await component.getByText("More positions remain. Load the next page to continue the scan.", { exact: false }).waitFor();
  assert.doesNotMatch(await component.locator("body").innerText(), /no qualifying locks|no eligible locks|wallet is not eligible/i, "One partial page must not establish wallet-wide ineligibility");
  await component.getByRole("button", { name: "Refresh", exact: true }).click();
  await component.getByText("Loading positions...", { exact: true }).waitFor();
  await resolveRead(component, (await newest(component)).id, { ids: [] });
  await component.getByText("No positions found at this snapshot.", { exact: true }).waitFor();
  await component.getByRole("button", { name: "Refresh", exact: true }).click();
  await component.getByText("Loading positions...", { exact: true }).waitFor();
  await component.evaluate(id => window.fixture.rejectRead(id, "Fixture rendered read failed"), (await newest(component)).id);
  await component.getByRole("alert").filter({ hasText: "Fixture rendered read failed" }).waitFor();
  await component.close();

  const disconnected = await open("mode=form&disconnected=1");
  const submit = page => page.locator("form button[type='submit']");
  await submit(disconnected).waitFor();
  assert(await submit(disconnected).isDisabled());
  assert.equal(await disconnected.getByLabel("Amount (CONV)", { exact: true }).inputValue(), "1000");
  assert.equal(await disconnected.getByLabel("Duration (days)", { exact: true }).inputValue(), "90");
  assert.equal(await disconnected.evaluate(() => window.fixture.walletRequests.length), 0);
  await disconnected.close();

  const form = await open("mode=form&case=reservation&holdWallet=1");
  await submit(form).waitFor();
  assert(await submit(form).isDisabled(), "The user must accept the displayed lock terms");
  await form.getByRole("checkbox", { name: "I accept that this CONV cannot be withdrawn before maturity.", exact: true }).check();
  await form.getByLabel("Amount (CONV)", { exact: true }).fill("1001");
  assert(!(await form.getByRole("checkbox").isChecked()), "Changing the accepted terms must require new consent");
  assert(await submit(form).isDisabled());
  await form.getByLabel("Amount (CONV)", { exact: true }).fill("1000");
  await form.getByRole("checkbox", { name: "I accept that this CONV cannot be withdrawn before maturity.", exact: true }).check();
  await form.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Approve and lock CONV" && !button.disabled));
  await submit(form).click();
  await form.waitForFunction(() => window.fixture.walletRequests.includes("eth_requestAccounts"));
  const reserved = await form.evaluate(async () => {
    const f = window.fixture;
    return f.journal.readLockAttempt(f.journal.lockAttemptKey(f.deployment, f.accountA));
  });
  assert.equal(reserved.status, "reserved", "The durable attempt must exist before the wallet is requested");
  assert.equal(reserved.account.toLowerCase(), account);
  assert(await submit(form).isDisabled());
  assert(await form.getByLabel("Amount (CONV)", { exact: true }).isDisabled());
  assert(await form.getByLabel("Duration (days)", { exact: true }).isDisabled());
  await form.reload();
  await form.getByText("An attempt is recorded for this account and vault. Automatic retries are disabled.", { exact: true }).waitFor();
  assert(await submit(form).isDisabled(), "Reloading an unresolved attempt must not permit a second send");
  assert.equal(await form.evaluate(() => window.fixture.walletRequests.length), 0);
  await form.close();

  const first = await open("mode=journal");
  const second = await open("mode=journal");
  const attempts = await Promise.all([first, second].map((page, index) => page.evaluate(({ index, owner }) => window.fixture.makeAttempt(`tab-${index}`, owner), { index, owner: otherAccount })));
  const winners = await Promise.all([first, second].map((page, index) => page.evaluate(attempt => window.fixture.journal.reserveLockAttempt(attempt), attempts[index])));
  assert.equal(winners.filter(Boolean).length, 1, "IndexedDB must atomically reserve one attempt across tabs");
  const winner = attempts[winners.findIndex(Boolean)];
  const loser = attempts[winners.findIndex(value => !value)];
  const saved = await second.evaluate(key => window.fixture.journal.readLockAttempt(key), winner.key);
  assert.equal(saved.id, winner.id);
  const overwrite = await first.evaluate(async attempt => {
    try { await window.fixture.journal.saveLockAttempt({ ...attempt, status: "pending" }); return "saved"; }
    catch (error) { return error.message; }
  }, loser);
  assert.notEqual(overwrite, "saved", "A losing tab must not overwrite another tab's attempt");
  assert.equal((await second.evaluate(key => window.fixture.journal.readLockAttempt(key), winner.key)).id, winner.id);
  await first.close();
  await second.close();

  for (const reason of ["unmount", "accountsChanged"]) {
    const stoppedContext = await browser.newContext();
    const stopped = await open(`mode=form&case=stopped-${reason}&holdWallet=1`, stoppedContext);
    await stopped.getByRole("checkbox", { name: "I accept that this CONV cannot be withdrawn before maturity.", exact: true }).check();
    await stopped.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Approve and lock CONV" && !button.disabled));
    await submit(stopped).click();
    await stopped.waitForFunction(() => window.fixture.walletRequests.includes("eth_requestAccounts"));
    await stopped.evaluate(value => {
      if (value === "unmount") window.fixture.unmountForm();
      else window.fixture.emitWallet("accountsChanged", [window.fixture.accountB]);
      window.fixture.releaseWallet();
    }, reason);
    await stopped.waitForFunction(async () => {
      const f = window.fixture;
      return (await f.journal.readLockAttempt(f.journal.lockAttemptKey(f.deployment, f.accountA)))?.status === "needs-review";
    });
    assert.equal(await stopped.evaluate(() => window.fixture.sends.length), 0, `${reason} during a wallet prompt must stop subsequent writes`);
    assert.equal(session(`stopped-${reason}`).sends.length, 0);
    await stoppedContext.close();
  }

  const successfulContext = await browser.newContext();
  const successful = await open("mode=form&case=confirmed", successfulContext);
  await successful.getByRole("checkbox", { name: "I accept that this CONV cannot be withdrawn before maturity.", exact: true }).check();
  await successful.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Approve and lock CONV" && !button.disabled));
  await submit(successful).evaluate(button => { button.click(); button.click(); });
  await successful.getByText("Confirmed position #42.", { exact: true }).waitFor();
  assert.deepEqual(session("confirmed").sends.map(item => item.kind), ["approve", "lockUntilMaturity"], "Repeated submit clicks must create exactly one approval and one lock");
  const confirmed = await successful.evaluate(async () => {
    const f = window.fixture;
    return f.journal.readLockAttempt(f.journal.lockAttemptKey(f.deployment, f.accountA));
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.positionId, "42");
  assert.deepEqual(confirmed.transactions.map(item => item.step), ["approve", "lock"]);
  assert(await submit(successful).isDisabled());
  await successful.reload();
  await successful.getByText("Confirmed position #42.", { exact: true }).waitFor();
  assert(await submit(successful).isDisabled());
  assert.equal(await successful.evaluate(() => window.fixture.walletRequests.length), 0);
  await successfulContext.close();

  const deniedContext = await browser.newContext();
  await deniedContext.addInitScript(() => { IDBFactory.prototype.open = () => { throw new DOMException("Fixture storage denied", "SecurityError"); }; });
  const denied = await open("mode=form&case=storage-denied", deniedContext);
  await denied.getByRole("alert").waitFor();
  assert(await submit(denied).isDisabled());
  assert.equal(await denied.evaluate(() => window.fixture.walletRequests.length), 0, "Unavailable durable storage must prevent wallet requests");
  await deniedContext.close();

  const failedWriteContext = await browser.newContext();
  await failedWriteContext.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (value?.status === "pending") throw new DOMException("Fixture hash persistence failed", "QuotaExceededError");
      return put.call(this, value, ...args);
    };
  });
  const failedWrite = await open("mode=form&case=hash-save-failed", failedWriteContext);
  await failedWrite.getByRole("checkbox", { name: "I accept that this CONV cannot be withdrawn before maturity.", exact: true }).check();
  await failedWrite.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Approve and lock CONV" && !button.disabled));
  await submit(failedWrite).click();
  await failedWrite.waitForFunction(() => window.fixture.sends.length > 0);
  await failedWrite.getByText(/Fixture hash persistence failed/).first().waitFor();
  await settle(failedWrite);
  assert.equal(session("hash-save-failed").sends.length, 1, "A failed hash journal update must block the subsequent lock transaction");
  assert.equal(session("hash-save-failed").sends[0].kind, "approve");
  assert(await submit(failedWrite).isDisabled());
  await failedWriteContext.close();

  assert.deepEqual(errors, []);
  console.log("PASS: copied React source runs independently; StrictMode reads, pagination, refresh/account races, token formatting, consent, durable reservations, reload protection, cross-tab ownership, wallet lifecycle, confirmation and write persistence barriers");
} finally {
  await browser?.close();
  if (server?.listening) { server.close(); server.closeAllConnections(); await once(server, "close"); }
  await rm(directory, { recursive: true, force: true });
}
