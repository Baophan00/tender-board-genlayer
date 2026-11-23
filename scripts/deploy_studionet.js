#!/usr/bin/env node
/**
 * Publish TenderBoard V1 to GenLayer Studio Network.
 *
 *   node scripts/deploy_studionet.js
 *
 * The key pair is created next to this script on first use and reused after
 * that, so the buyer address stays stable between runs. The key file is local,
 * gitignored and mode 0600; it is never printed. The receipt is persisted to
 * artifacts/deploy.json because stdout is easy to lose during a long run.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const KEY_PATH = path.join(__dirname, ".tender-keys.json");
const ARTIFACT = path.join(process.cwd(), "artifacts/deploy.json");
const SOURCE = path.join(process.cwd(), "contracts/tender_board.py");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKeys() {
  if (fs.existsSync(KEY_PATH)) return JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
  const fresh = {
    buyer: generatePrivateKey(),
    bidder_a: generatePrivateKey(),
    bidder_b: generatePrivateKey(),
    observer: generatePrivateKey(),
  };
  fs.writeFileSync(KEY_PATH, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh;
}

async function retrying(label, fn) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error && error.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available|429|500/i.test(message)) {
        throw error;
      }
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${attempt + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

// `genlayer code` wraps the source in a preamble and a trailing check mark.
// Strip those lines only; the source itself is compared byte for byte.
function deployedSource(address) {
  const run = spawnSync("genlayer", ["code", address], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (run.error) throw run.error;
  // The CLI prints only the preamble and the source on stdout; progress and
  // the trailing check mark go to stderr. Take everything after "Result:".
  const lines = (run.stdout || "").split("\n");
  const start = lines.findIndex((line) => line.trim() === "Result:");
  if (start < 0) throw new Error("no Result: marker in genlayer code output");
  return lines.slice(start + 1).join("\n").trimEnd() + "\n";
}

(async () => {
  if (process.argv[2] === "--verify") {
    const address = process.argv[3];
    const tx = process.argv[4] || "";
    if (!address) throw new Error("usage: node scripts/deploy_studionet.js --verify <address> [tx]");
    const local = fs.readFileSync(SOURCE, "utf8");
    let match = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        match = deployedSource(address) === local.trimEnd() + "\n";
        if (match) break;
      } catch (error) {
        console.log(`  code read: ${String(error.message).slice(0, 90)}`);
      }
      await sleep(3000);
    }
    const client = createClient({ chain: studionet, account: createAccount(loadKeys().buyer) });
    const stats = await retrying("stats", () => client.readContract({ address, functionName: "stats", args: [] }));
    fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
    fs.writeFileSync(ARTIFACT, JSON.stringify({
      address, deployTx: tx, localSourceSha256: crypto.createHash("sha256").update(local).digest("hex"),
      sourceMatch: match, stats, verifiedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    console.log(`source matches local: ${match}`);
    console.log(`RESULT: verified ${address} against local source; artifact ${ARTIFACT}`);
    if (!match) throw new Error("deployed source does not match local contracts/tender_board.py");
    return;
  }
  const keys = loadKeys();
  const account = createAccount(keys.buyer);
  const client = createClient({ chain: studionet, account });
  const local = fs.readFileSync(SOURCE, "utf8");
  const localHash = crypto.createHash("sha256").update(local).digest("hex");

  console.log("buyer ", account.address);
  const hash = await retrying("deploy", () => client.deployContract({ code: new Uint8Array(Buffer.from(local)), args: [] }));
  console.log("deploy tx", hash);

  const receipt = await retrying("receipt", () =>
    client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 })
  );
  const address =
    receipt.data?.contract_address ||
    receipt.txDataDecoded?.contractAddress ||
    receipt.data?.contractAddress;
  if (!address) throw new Error(`no address in the receipt: ${JSON.stringify(receipt).slice(0, 600)}`);

  // A deploy receipt can be FINALIZED even when __init__ raised: read a view.
  const stats = await retrying("stats", () => client.readContract({ address, functionName: "stats", args: [] }));
  const delivered = await retrying("delivery views", () =>
    client.readContract({ address, functionName: "delivery_of", args: ["__none__"] }).catch(() => "absent as expected")
  );

  let sourceMatch = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      sourceMatch = deployedSource(address) === local.trimEnd() + "\n";
      if (sourceMatch) break;
    } catch (error) {
      console.log(`  code read: ${String(error.message).slice(0, 90)}`);
    }
    await sleep(5000);
  }

  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify({
    address, deployTx: hash, localSourceSha256: localHash,
    sourceMatch, stats, deployedAt: new Date().toISOString(),
  }, null, 2) + "\n");

  console.log("contract", address);
  console.log("stats   ", JSON.stringify(stats));
  console.log("delivery view before any definition", String(delivered).slice(0, 80));
  console.log(`source matches local: ${sourceMatch}`);
  console.log(`RESULT: deployed ${address} in ${hash}; artifact ${ARTIFACT}`);
  if (!sourceMatch) throw new Error("deployed source does not match local contracts/tender_board.py");
})().catch((error) => {
  console.error("FAILED:", error.message);
  if (error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
