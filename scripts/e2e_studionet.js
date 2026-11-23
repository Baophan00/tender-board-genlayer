#!/usr/bin/env node
/**
 * Full TenderBoard V1 run on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress> [tenderId]
 *
 * Opens a tender, seals and reveals two bids, scores both proposals in two
 * consensus rounds, awards, then exercises the new post-award product:
 * three checkpoints defined by the buyer, proof for two of them read by the
 * validators in two real consensus rounds, one malformed proof refused, one
 * duplicate refused, buyer acceptance, and a certificate whose on-time / late
 * / missed counts are checked against the stored checkpoints.
 *
 * Every transaction hash is printed, including the ones the contract refused.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");
const FEE_PROFILE = require("../fee-profile.json");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress> [tenderId]");
  process.exit(1);
}

const KEY_PATH = process.env.TB_KEYS || path.join(__dirname, ".tender-keys.json");
const keys = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TX = [];

const parties = {
  buyer: createClient({ chain: studionet, account: createAccount(keys.buyer) }),
  winner: createClient({ chain: studionet, account: createAccount(keys.bidder_a) }),
  loser: createClient({ chain: studionet, account: createAccount(keys.bidder_b) }),
};
const watcher = createClient({ chain: studionet, account: createAccount(keys.observer) });

async function feesFor(fn) {
  const row = FEE_PROFILE.methods[fn] || FEE_PROFILE.deploy;
  const estimate = await watcher.estimateTransactionFees({
    leaderTimeunitsAllocation: BigInt(row.leaderTimeunitsAllocation),
    validatorTimeunitsAllocation: BigInt(row.validatorTimeunitsAllocation),
    executionBudgetPerRound: BigInt(row.executionBudgetPerRound),
    totalMessageFees: BigInt(row.totalMessageFees || "0"),
    appealRounds: 0n,
    rotations: [0n],
  });
  return { distribution: estimate.distribution, feeValue: estimate.feeValue };
}

async function retrying(label, fn) {
  let last;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error && error.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available|HTML|429|500|Unexpected end of JSON|Invalid JSON|Unexpected token|socket/i.test(message)) {
        throw error;
      }
      last = error;
      console.log(`  ${label}: rpc hiccup, retry ${attempt + 1}`);
      await sleep(5000);
    }
  }
  throw last;
}

function executionFailed(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function call(role, fn, args, expectRefusal = false) {
  console.log(`\n[${role}] ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 70)).join(", ")})`);
  const fees = await feesFor(fn);
  const hash = await retrying("send", () =>
    parties[role].writeContract({ address: ADDRESS, functionName: fn, args, value: 0n, fees })
  );
  TX.push([fn + (expectRefusal ? " (refused)" : ""), hash]);
  console.log(`  tx ${hash}`);
  const receipt = await retrying("receipt", () =>
    parties[role].waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 4000 })
  );
  const failed = executionFailed(receipt);
  console.log(`  ${receipt.status_name || receipt.status}  (${failed ? "refused by the contract" : "executed"})`);
  if (expectRefusal !== failed) {
    throw new Error(`${fn}: expected ${expectRefusal ? "a refusal" : "an applied write"}, got ${failed ? "a refusal" : "success"}`);
  }
  return hash;
}

const must = (role, fn, args) => call(role, fn, args, false);
const refuse = (role, fn, args) => call(role, fn, args, true);
const view = (fn, args) =>
  retrying("read", () => watcher.readContract({ address: ADDRESS, functionName: fn, args }));

const digest = (price, days, salt) =>
  require("crypto").createHash("sha256").update(`${price}:${days}:${salt}`).digest("hex");

const BASE = "https://tenderboard-genlayer.surge.sh/demo";
const BRIEF = `${BASE}/brief.html`;
const STRONG = `${BASE}/proposal-strong.html`;
const WEAK = `${BASE}/proposal-adequate.html`;
const PROOF_ON_TIME = `${BASE}/proof-on-time.html`;
const PROOF_LATE = `${BASE}/proof-late.html`;
const WEIGHTS = { quality: 60, price: 30, delivery: 10 };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const tenderId = process.argv[3] || `v1-${Date.now().toString(36)}`;
  console.log("contract", ADDRESS);
  console.log("tender  ", tenderId);

  console.log("\n== V0 workflow: sealed bidding, two readings, an award ==");
  await must("buyer", "open_tender", [
    tenderId, "Documentation tooling for a 40-person team", BRIEF, JSON.stringify(WEIGHTS), 1200, 4,
  ]);
  let tender = await view("get_tender", [tenderId]);
  assert(tender.status === "open", "the tender did not open");

  await refuse("buyer", "commit_bid", [tenderId, digest(1000, 30, "buyer-salt")]);

  await must("winner", "commit_bid", [tenderId, digest(1000, 30, "salt-alpha-1")]);
  await must("winner", "reveal_bid", [tenderId, 1000, 30, "salt-alpha-1", STRONG]);
  await must("loser", "commit_bid", [tenderId, digest(800, 40, "salt-beta-22")]);
  await refuse("loser", "reveal_bid", [tenderId, 800, 40, "salt-wrong-99", WEAK]);
  let bids = await view("bids_of", [tenderId]);
  assert(bids.find((b) => b.seq === 2).revealed === false, "a refused reveal opened the bid");
  await must("loser", "reveal_bid", [tenderId, 800, 40, "salt-beta-22", WEAK]);

  await must("buyer", "close_bidding", [tenderId]);
  let t0 = Date.now();
  await must("buyer", "score_bid", [tenderId, 1]);
  console.log(`  scoring round took ${Math.round((Date.now() - t0) / 1000)}s`);
  t0 = Date.now();
  await must("buyer", "score_bid", [tenderId, 2]);
  console.log(`  scoring round took ${Math.round((Date.now() - t0) / 1000)}s`);

  await must("buyer", "award", [tenderId]);
  tender = await view("get_tender", [tenderId]);
  bids = await view("bids_of", [tenderId]);
  const best = bids.reduce((acc, b) => (b.total > acc.total ? b : acc), bids[0]);
  assert(tender.status === "awarded", "the tender was not awarded");
  assert(tender.winner === best.bidder, "the award is not the highest total");
  console.log(`  winner ${tender.winner} with ${tender.winning_total} points on bid ${tender.winning_bid}`);

  console.log("\n== V1: post-award delivery ==");
  const CHECKPOINTS = [
    { title: "Design sign-off", due_days: 365 },
    { title: "Handover", due_days: 0 },
    { title: "Final acceptance", due_days: 0 },
  ];
  await must("buyer", "define_delivery", [tenderId, JSON.stringify(CHECKPOINTS)]);
  let delivery = await view("delivery_of", [tenderId]);
  assert(delivery.status === "active" && delivery.checkpoints === 3, "delivery was not defined");
  console.log(`  ${delivery.checkpoints} checkpoints, winner ${delivery.winner}`);

  await refuse("buyer", "accept_delivery", [tenderId]);              // no proof yet
  await refuse("winner", "submit_delivery", [tenderId, 1, "not-a-url"]); // malformed proof

  t0 = Date.now();
  await must("winner", "submit_delivery", [tenderId, 1, PROOF_ON_TIME]);
  console.log(`  proof round 1 took ${Math.round((Date.now() - t0) / 1000)}s`);
  t0 = Date.now();
  await must("winner", "submit_delivery", [tenderId, 2, PROOF_LATE]);
  console.log(`  proof round 2 took ${Math.round((Date.now() - t0) / 1000)}s`);

  delivery = await view("delivery_of", [tenderId]);
  assert(delivery.submitted === 2, `expected 2 submissions, got ${delivery.submitted}`);
  const rows = await view("delivery_checkpoints", [tenderId]);
  for (const row of rows) {
    console.log(`  checkpoint ${row.seq} ${row.title}: ${row.bucket || "no proof"} / ${row.timing || "pending"}`);
  }
  assert(rows[0].bucket === "COMPLETE", `the on-time proof was read as ${rows[0].bucket}`);
  assert(["PARTIAL", "MISSING"].includes(rows[1].bucket), `the late proof was read as ${rows[1].bucket}`);
  assert(rows[0].timing === "ON_TIME", `checkpoint 1 was ${rows[0].timing}`);
  assert(rows[1].timing === "LATE", `checkpoint 2 was ${rows[1].timing}`);
  assert(rows[2].timing === "" && rows[2].submitted_at === 0, "checkpoint 3 should be unsubmitted");

  await refuse("winner", "submit_delivery", [tenderId, 1, PROOF_ON_TIME]); // duplicate
  await refuse("loser", "accept_delivery", [tenderId]);                    // authority
  await must("winner", "submit_delivery", [tenderId, 3, PROOF_ON_TIME]);   // last checkpoint
  delivery = await view("delivery_of", [tenderId]);
  assert(delivery.submitted === 3, `expected 3 submissions, got ${delivery.submitted}`);

  await must("buyer", "accept_delivery", [tenderId]);
  delivery = await view("delivery_of", [tenderId]);
  assert(delivery.status === "accepted" && delivery.decision === "accepted", "acceptance was not written");

  await must("buyer", "close_delivery", [tenderId]);
  const cert = await view("completion_certificate", [tenderId]);
  const finalRows = await view("delivery_checkpoints", [tenderId]);
  console.log("\ncertificate", JSON.stringify(cert, null, 2));

  assert(cert.tender_id === tenderId && cert.winner === tender.winner, "certificate names the wrong tender/winner");
  assert(cert.decision === "accepted", "certificate decision is wrong");
  assert(cert.checkpoints === 3 && cert.submitted === 3, "certificate checkpoint counts are wrong");
  assert(cert.on_time === finalRows.filter((r) => r.timing === "ON_TIME").length, "on_time count is wrong");
  assert(cert.late === finalRows.filter((r) => r.timing === "LATE").length, "late count is wrong");
  assert(cert.missed === finalRows.filter((r) => r.timing === "MISSED").length, "missed count is wrong");
  assert(cert.on_time + cert.late + cert.missed === 3, "the three checkpoints were not all timed");
  assert(cert.complete === finalRows.filter((r) => r.bucket === "COMPLETE").length, "complete count is wrong");
  assert(cert.partial === finalRows.filter((r) => r.bucket === "PARTIAL").length, "partial count is wrong");
  assert(cert.missing === finalRows.filter((r) => r.bucket === "MISSING").length, "missing bucket count is wrong");
  assert(cert.certificate_id === `TB-V1-${tenderId}-${cert.closed_at}`, "certificate id is wrong");

  console.log("\nstats", JSON.stringify(await view("stats", [])));
  console.log("\nTRANSACTIONS");
  for (const [label, hash] of TX) console.log(`  ${label.padEnd(24)} ${hash}`);
  console.log(
    "\nRESULT: V1 PASS — two sealed bids scored and awarded; three checkpoints; three real consensus proof rounds with contract-computed buckets; " +
    "malformed proof, early acceptance, duplicate proof and wrong-signer acceptance refused; " +
    `accepted; certificate ${cert.on_time}/${cert.late}/${cert.missed} on-time/late/missed on ${TX.length} transactions`
  );
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  console.error("transactions so far:");
  for (const [label, hash] of TX) console.error(`  ${label.padEnd(24)} ${hash}`);
  if (error.cause) console.error(String(error.cause).slice(0, 900));
  process.exit(1);
});
