#!/usr/bin/env node
/**
 * A whole tender on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * Two bidders seal a price, reveal a proposal, the buyer closes the bidding and
 * one consensus round reads each proposal against the brief. The award is
 * computed in code: the cheaper bid wins on price, the better proposal wins on
 * quality, and the weights decide which of those matters more.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEY_PATH = process.env.TB_KEYS || path.join(__dirname, ".tender-keys.json");
const keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parties = {
  buyer: createClient({ chain: studionet, account: createAccount(keys.buyer) }),
  bidder_a: createClient({ chain: studionet, account: createAccount(keys.bidder_a) }),
  bidder_b: createClient({ chain: studionet, account: createAccount(keys.bidder_b) }),
};
const watcher = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

async function retrying(label, fn) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error && error.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(message)) {
        throw error;
      }
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${attempt + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

function executionFailed(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function call(role, fn, args) {
  console.log(`\n[${role}] ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 56)).join(", ")})`);
  const hash = await retrying("send", () =>
    parties[role].writeContract({ address: ADDRESS, functionName: fn, args, value: 0n })
  );
  console.log(`  tx ${hash}`);
  const receipt = await retrying("receipt", () =>
    parties[role].waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 })
  );
  const failed = executionFailed(receipt);
  console.log(`  ${receipt.status_name || receipt.status}  (${failed ? "refused by the contract" : "executed"})`);
  return { hash, failed };
}

async function must(role, fn, args) {
  const out = await call(role, fn, args);
  if (out.failed) throw new Error(`${fn} was refused`);
  return out.hash;
}

const view = (fn, args) =>
  retrying("read", () => watcher.readContract({ address: ADDRESS, functionName: fn, args }));

const digest = (price, days, salt) =>
  require("crypto").createHash("sha256").update(`${price}:${days}:${salt}`).digest("hex");

const BASE = "https://tenderboard-genlayer.surge.sh/demo";
const BRIEF = `${BASE}/brief.html`;
const STRONG = `${BASE}/proposal-strong.html`;
const WEAK = `${BASE}/proposal-adequate.html`;
const WEIGHTS = { quality: 60, price: 30, delivery: 10 };

(async () => {
  const tenderId = process.argv[3] || `tender-${Date.now().toString(36)}`;
  console.log("contract", ADDRESS);
  console.log("tender  ", tenderId);

  await must("buyer", "open_tender", [
    tenderId, "Documentation tooling for a 40-person team", BRIEF, JSON.stringify(WEIGHTS), 1200, 4,
  ]);

  let tender = await view("get_tender", [tenderId]);
  console.log(`\n  open | budget ${tender.budget} | weights ${JSON.stringify(tender.weights)} | max ${tender.max_bids} bids`);

  console.log("\n[guard] the buyer cannot bid on their own tender");
  const selfBid = await call("buyer", "commit_bid", [tenderId, digest(1000, 30, "buyer-salt")]);
  if (!selfBid.failed) throw new Error("the buyer was allowed to bid");

  console.log("\n[bidder_a] seal 1000 credits, 30 days");
  await must("bidder_a", "commit_bid", [tenderId, digest(1000, 30, "salt-alpha-1")]);
  await must("bidder_a", "reveal_bid", [tenderId, 1000, 30, "salt-alpha-1", STRONG]);

  console.log("\n[bidder_b] seal 800 credits, 40 days");
  await must("bidder_b", "commit_bid", [tenderId, digest(800, 40, "salt-beta-22")]);

  console.log("\n[guard] a reveal with the wrong salt is refused, and the bid stays sealed");
  const badReveal = await call("bidder_b", "reveal_bid", [tenderId, 800, 40, "salt-wrong-99", WEAK]);
  if (!badReveal.failed) throw new Error("a reveal with the wrong salt was accepted");
  const sealed = (await view("bids_of", [tenderId])).find((b) => b.seq === 2);
  if (sealed.revealed) throw new Error("the refused reveal still opened the bid");
  console.log(`  bid 2 stays sealed: price ${sealed.price}, revealed ${sealed.revealed}`);

  await must("bidder_b", "reveal_bid", [tenderId, 800, 40, "salt-beta-22", WEAK]);

  console.log("\n[buyer] close the bidding");
  await must("buyer", "close_bidding", [tenderId]);

  console.log("\n[buyer] score bid 1 against the brief");
  let t0 = Date.now();
  await must("buyer", "score_bid", [tenderId, 1]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);

  console.log("\n[buyer] score bid 2 against the brief");
  t0 = Date.now();
  await must("buyer", "score_bid", [tenderId, 2]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);

  console.log("\n[buyer] award: the weights decide");
  await must("buyer", "award", [tenderId]);

  tender = await view("get_tender", [tenderId]);
  const bids = await view("bids_of", [tenderId]);
  console.log("");
  for (const b of bids) {
    console.log(
      `  bid ${b.seq} ${b.bidder.slice(0, 10)}… price ${String(b.price).padStart(4)} | days ${String(b.days).padStart(2)} | ${b.bucket.padEnd(8)} | quality ${String(b.quality).padStart(3)} | price score ${String(b.price_score).padStart(3)} | delivery ${String(b.delivery_score).padStart(3)} | total ${b.total}`
    );
  }
  console.log(`\n  winner ${tender.winner} with ${tender.winning_total} points on bid ${tender.winning_bid}`);

  const best = bids.reduce((acc, b) => (b.total > acc.total ? b : acc), bids[0]);
  if (tender.winner !== best.bidder) throw new Error("the award does not match the highest total");

  console.log("\nstats");
  console.log(JSON.stringify(await view("stats", []), null, 2));

  console.log(
    "\nRESULT: two sealed bids, one refused reveal that kept the bid sealed, two proposal readings, and an award computed from the weights"
  );
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  if (error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
