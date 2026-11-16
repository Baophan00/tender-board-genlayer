import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0x2B136ef09CDd0dc463560C13C2eC737C3EB65C81";
const EXPLORER = `https://explorer-studio.genlayer.com/address/${CONTRACT}`;
const KEY_SLOT = "tenderboard.key";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

let account = null;
let client = null;
let selected = null;
let cache = { tender: null, bids: [] };

function toast(message, isError) {
  document.querySelectorAll(".toast").forEach((n) => n.remove());
  const node = el("div", `toast${isError ? " err" : ""}`, message);
  document.body.append(node);
  setTimeout(() => node.remove(), isError ? 9000 : 4200);
}

function loadKey() {
  const raw = localStorage.getItem(KEY_SLOT);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  const key = { privateKey: generatePrivateKey() };
  localStorage.setItem(KEY_SLOT, JSON.stringify(key));
  return key;
}

function boot() {
  const key = loadKey();
  account = createAccount(key.privateKey);
  client = createClient({ chain: studionet, account });
  $("who").textContent = short(account.address);
  $("who").title = account.address;
}

$("keybtn").addEventListener("click", () => {
  const fresh = { privateKey: generatePrivateKey() };
  localStorage.setItem(KEY_SLOT, JSON.stringify(fresh));
  boot();
  renderAll();
  toast("New key. Bids and tenders from the old key are still on chain.");
});

const read = (functionName, args) =>
  client.readContract({ address: CONTRACT, functionName, args });

const write = (functionName, args) =>
  client.writeContract({ address: CONTRACT, functionName, args, value: 0n });

async function run(label, fn, args) {
  try {
    toast(`${label}…`);
    const hash = await write(fn, args);
    const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 });
    const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
    if (String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR") {
      throw new Error("the contract refused this call");
    }
    toast(`${label}: done`);
    await renderAll();
    return true;
  } catch (error) {
    const message = String((error && error.message) || error);
    toast(`${label} failed: ${message.slice(0, 220)}`, true);
    return false;
  }
}

async function commitmentFor(price, days, salt) {
  const bytes = new TextEncoder().encode(`${price}:${days}:${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --------------------------------------------------------------------- render

async function renderStats() {
  try {
    const s = await read("stats", []);
    $("stats").replaceChildren(
      ...[
        ["Tenders", s.tenders],
        ["Open", s.open],
        ["Awarded", s.awarded],
        ["Bids sealed", s.bids],
      ].map(([label, value]) => {
        const box = el("div", "stat");
        box.append(el("b", "", String(value)));
        box.append(el("span", "", label));
        return box;
      })
    );
  } catch (error) {
    $("stats").replaceChildren(el("div", "empty", `could not read the contract: ${String(error.message).slice(0, 120)}`));
  }
}

async function renderList() {
  let rows = [];
  try {
    rows = await read("list_tenders", [0, 30]);
  } catch (error) {
    $("list").replaceChildren(el("div", "empty", String(error.message).slice(0, 140)));
    return;
  }
  $("count").textContent = String(rows.length);
  if (!rows.length) {
    $("list").replaceChildren(el("div", "card-body", "No tender yet. Publish one, or open the demo tender."));
    return;
  }
  $("list").replaceChildren(
    ...rows.map((tender) => {
      const button = el("button", `tender${selected === tender.id ? " sel" : ""}`);
      const row = el("div", "row1");
      row.append(el("h3", "", tender.title));
      row.append(el("span", `pill ${tender.status}`, tender.status));
      button.append(row);
      const sub = el("div", "sub");
      sub.append(el("span", "", `budget ${tender.budget}`));
      sub.append(el("span", "", `${tender.bids} bids`));
      sub.append(el("span", "", `${tender.weights.quality}/${tender.weights.price}/${tender.weights.delivery}`));
      if (tender.winner) sub.append(el("span", "", `won by ${short(tender.winner)}`));
      button.append(sub);
      button.addEventListener("click", () => {
        selected = tender.id;
        renderAll();
      });
      return button;
    })
  );
  if (!selected) {
    selected = rows[0].id;
    await renderDetail();
  }
}

function weightBar(weights) {
  const wrap = el("div", "weights");
  for (const [key, cls] of [["quality", "w-quality"], ["price", "w-price"], ["delivery", "w-delivery"]]) {
    const part = el("i", cls);
    part.style.width = `${weights[key]}%`;
    wrap.append(part);
  }
  const legend = el("div", "legend");
  for (const [key, cls] of [["quality", "w-quality"], ["price", "w-price"], ["delivery", "w-delivery"]]) {
    const item = el("span");
    const dot = el("span", `dot ${cls}`);
    item.append(dot, document.createTextNode(`${key} ${weights[key]}%`));
    legend.append(item);
  }
  return [wrap, legend];
}

function stepper(tender) {
  const steps = el("div", "steps");
  const state = tender.status;
  const order = [
    ["sealed bids", state === "open"],
    ["bidding closed", state === "scoring" || state === "awarded"],
    ["readings", tender.scored > 0 || state === "awarded"],
    ["award", state === "awarded"],
  ];
  let reached = true;
  for (const [label, on] of order) {
    const step = el("div", `step${on && reached ? " on" : ""}`, label);
    steps.append(step);
    if (!on) reached = false;
  }
  return steps;
}

function scoreBars(bid) {
  const bars = el("div", "bars");
  const rows = [
    ["quality", bid.quality],
    ["price", bid.price_score],
    ["delivery", bid.delivery_score],
  ];
  for (const [label, value] of rows) {
    const row = el("div", "bar-row");
    row.append(el("span", "", label));
    const track = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    track.append(fill);
    row.append(track, el("span", "", String(value)));
    bars.append(row);
  }
  return bars;
}

function bidRow(bid, tender, isBuyer) {
  const box = el("div", "bid");
  const head = el("div", "bid-head");
  head.append(el("strong", "", `bid ${bid.seq}`));
  head.append(el("span", "who", `${short(bid.bidder)}${bid.bidder === account.address.toLowerCase() ? " (you)" : ""}`));
  if (!bid.revealed) head.append(el("span", "pill", "sealed"));
  else if (bid.bucket) head.append(el("span", `pill ${bid.total >= 80 ? "awarded" : bid.bucket === "weak" ? "cancelled" : "scoring"}`, bid.bucket));
  else head.append(el("span", "pill open", "revealed, no reading"));
  if (tender.winner && bid.bidder === tender.winner) head.append(el("span", "pill awarded", "winner"));
  box.append(head);

  const meta = el("div", "bid-meta");
  meta.textContent = bid.revealed
    ? `price ${bid.price} / ${bid.days} days / total ${bid.total || "pending"}`
    : "price hidden until the bidder reveals it";
  box.append(meta);

  if (bid.quote) box.append(el("div", "quote", `“${bid.quote}”`));
  if (bid.revealed && bid.bucket) box.append(scoreBars(bid));
  if (bid.revealed && !bid.bucket && isBuyer && tender.status === "scoring") {
    const actions = el("div", "actions");
    const score = el("button", "", "Read this proposal");
    score.addEventListener("click", () => run(`Reading bid ${bid.seq}`, "score_bid", [tender.id, bid.seq]));
    actions.append(score);
    box.append(actions);
  }
  return box;
}

function revealForm(tender) {
  const form = el("div", "card-body");
  form.append(el("h2", "", "Reveal your bid"));
  form.append(el("p", "note", "Commitment first, then the values and the salt you hashed. The contract checks the hash."));

  const build = async () => {
    const price = Number($("r-price").value);
    const days = Number($("r-days").value);
    const salt = $("r-salt").value;
    if (!price || !days || salt.length < 8) {
      $("r-hash").textContent = "fill price, days and a salt of 8+ characters";
      return null;
    }
    const hash = await commitmentFor(price, days, salt);
    $("r-hash").textContent = hash;
    return { price, days, salt, hash };
  };

  form.append(el("label", "", "Proposal URL"));
  const url = el("input");
  url.id = "r-url";
  url.placeholder = "https://example.org/proposal.html";
  form.append(url);

  const row = el("div", "three");
  const price = el("input");
  price.id = "r-price"; price.type = "number"; price.placeholder = "950";
  const days = el("input");
  days.id = "r-days"; days.type = "number"; days.placeholder = "30";
  const salt = el("input");
  salt.id = "r-salt"; salt.placeholder = "salt-alpha-1";
  for (const [label, input] of [["Price", price], ["Days", days], ["Salt", salt]]) {
    const cell = el("div");
    cell.append(el("label", "", label), input);
    row.append(cell);
  }
  form.append(row);

  const hashLabel = el("div", "hint");
  hashLabel.id = "r-hash";
  hashLabel.textContent = "the commitment is computed in your browser";
  form.append(hashLabel);

  const actions = el("div", "actions");
  const commitBtn = el("button", "", "Commit hash");
  commitBtn.addEventListener("click", async () => {
    const values = await build();
    if (!values) return;
    await run("Commit", "commit_bid", [tender.id, values.hash]);
  });
  const revealBtn = el("button", "primary", "Reveal");
  revealBtn.addEventListener("click", async () => {
    const values = await build();
    if (!values) return;
    const urlValue = $("r-url").value.trim();
    if (!urlValue) { toast("a proposal URL is required to reveal", true); return; }
    await run("Reveal", "reveal_bid", [tender.id, values.price, values.days, values.salt, urlValue]);
  });
  actions.append(commitBtn, revealBtn);
  form.append(actions);
  return form;
}

async function renderDetail() {
  if (!selected) return;
  let tender;
  let bids;
  try {
    tender = await read("get_tender", [selected]);
    bids = await read("bids_of", [selected]);
  } catch (error) {
    $("detail").replaceChildren(el("div", "card-body empty", String(error.message).slice(0, 160)));
    return;
  }
  cache = { tender, bids };
  const me = account.address.toLowerCase();
  const isBuyer = tender.buyer === me;

  const body = el("div", "card-body");
  const head = el("div", "row1");
  head.style.display = "flex";
  head.style.gap = "8px";
  head.style.alignItems = "center";
  head.append(el("h2", "detail-title", tender.title));
  head.append(el("span", `pill ${tender.status}`, tender.status));
  body.append(head);
  body.append(el("div", "kv", `buyer ${short(tender.buyer)}${isBuyer ? " (you)" : ""} / budget ${tender.budget} / up to ${tender.max_bids} bids`));
  body.append(el("div", "kv", `brief: ${tender.brief_url}`));

  const [bar, legend] = weightBar(tender.weights);
  body.append(bar, legend);
  body.append(stepper(tender));

  if (tender.winner) {
    const banner = el("div", "winner");
    banner.append(el("strong", "", `Awarded to ${short(tender.winner)} `));
    banner.append(document.createTextNode(`on bid ${tender.winning_bid} with ${tender.winning_total} points.`));
    body.append(banner);
  }

  const list = el("div");
  if (!bids.length) list.append(el("div", "empty", "No bid committed yet."));
  for (const bid of bids) list.append(bidRow(bid, tender, isBuyer));
  body.append(list);

  const actions = el("div", "actions");
  if (tender.status === "open" && isBuyer) {
    const close = el("button", "primary", "Close bidding");
    close.addEventListener("click", () => run("Close bidding", "close_bidding", [tender.id]));
    actions.append(close);
    const cancel = el("button", "ghost", "Cancel tender");
    cancel.addEventListener("click", () => run("Cancel", "cancel_tender", [tender.id]));
    actions.append(cancel);
  }
  if (tender.status === "scoring" && isBuyer) {
    const unscored = bids.filter((b) => b.revealed && !b.bucket).length;
    const award = el("button", "primary", unscored ? "Read every bid before awarding" : "Award");
    award.disabled = unscored > 0;
    award.addEventListener("click", () => run("Award", "award", [tender.id]));
    actions.append(award);
  }
  if (actions.childElementCount) body.append(actions);

  if (tender.status === "open") body.append(revealForm(tender));

  body.append(
    el("p", "note", `Weights fixed at open: quality ${tender.weights.quality} / price ${tender.weights.price} / delivery ${tender.weights.delivery}. Price score is 100 × cheapest/price, delivery 100 × fastest/days.`)
  );

  $("detail").replaceChildren(body);
}

async function renderAll() {
  await renderStats();
  await renderList();
  if (selected) await renderDetail();
}

$("toggle-open").addEventListener("click", () => {
  const form = $("open-form");
  form.style.display = form.style.display === "none" ? "block" : "none";
});

$("do-open").addEventListener("click", async () => {
  const title = $("f-title").value.trim();
  const brief = $("f-brief").value.trim();
  const budget = Number($("f-budget").value);
  const maxBids = Number($("f-bids").value);
  const weights = { quality: Number($("f-wq").value), price: Number($("f-wp").value), delivery: Number($("f-wd").value) };
  if (!title || !brief) { toast("a title and a brief URL are required", true); return; }
  if (weights.quality + weights.price + weights.delivery !== 100) { toast("the weights must sum to 100", true); return; }
  const id = `t-${Date.now().toString(36)}`;
  const ok = await run("Publish tender", "open_tender", [id, title, brief, JSON.stringify(weights), budget, maxBids]);
  if (ok) {
    selected = id;
    $("open-form").style.display = "none";
    await renderAll();
  }
});

boot();
renderAll();
setInterval(renderAll, 20000);
