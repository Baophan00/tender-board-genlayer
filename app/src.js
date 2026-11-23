import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0x41d619696bA027dEC52262b9bE14391f61796b44";
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
  const tag = document.getElementById("contract");
  if (tag) { tag.textContent = `contract ${short(CONTRACT)}`; tag.title = CONTRACT; }
}

const refreshBtn = document.getElementById("refresh");
if (refreshBtn) refreshBtn.addEventListener("click", () => renderAll());

$("keybtn").addEventListener("click", () => {
  const fresh = { privateKey: generatePrivateKey() };
  localStorage.setItem(KEY_SLOT, JSON.stringify(fresh));
  boot();
  renderAll();
  toast("New key. Bids and tenders from the old key are still on chain.");
});

const read = (functionName, args) =>
  client.readContract({ address: CONTRACT, functionName, args });

async function readWithRetry(functionName, args, tries = 2) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await read(functionName, args);
    } catch (error) {
      last = error;
      if (/rate limit|429/i.test(String((error && error.message) || error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw last;
}

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
    const s = await readWithRetry("stats", []);
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
    return;
  }
  const snapshot = document.getElementById("snapshot");
  if (snapshot) snapshot.style.display = "none";
}

async function renderList() {
  let rows = [];
  try {
    rows = await readWithRetry("list_tenders", [0, 30]);
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
  const state = tender.status;
  const order = [
    ["sealed bids", true],
    ["bidding closed", state === "scoring" || state === "awarded"],
    ["readings", tender.scored > 0 || state === "awarded"],
    ["award", state === "awarded"],
  ];
  const steps = el("div", "steps");
  for (const [label, on] of order) steps.append(el("div", `step${on ? " on" : ""}`, label));
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
  else if (bid.bucket) head.append(el("span", `pill ${bid.bucket === "strong" ? "strong" : bid.bucket === "weak" ? "weak" : "scoring"}`, bid.bucket));
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
  const form = el("div");
  form.style.marginTop = "20px";
  form.append(el("h2", "rubric-title", "Reveal your bid"));
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


// ------------------------------------------------------- V1 post-award delivery

function deliveryForm(tender) {
  const wrap = el("div");
  wrap.style.marginTop = "20px";
  wrap.append(el("h2", "rubric-title", "Define delivery checkpoints"));
  wrap.append(el("p", "note", "Fixed after the award. due_days counts from now; 0 is due immediately."));
  const input = el("textarea");
  input.id = "dl-json";
  input.value = JSON.stringify([
    { title: "Design sign-off", due_days: 10 },
    { title: "Handover", due_days: 0 },
  ], null, 2);
  wrap.append(input);
  const actions = el("div", "actions");
  const button = el("button", "primary", "Define checkpoints");
  button.addEventListener("click", async () => {
    let items;
    try { items = JSON.parse(input.value); }
    catch { toast("checkpoints must be valid JSON", true); return; }
    await run("Define delivery", "define_delivery", [tender.id, JSON.stringify(items)]);
  });
  actions.append(button);
  wrap.append(actions);
  return wrap;
}

function checkpointCard(row, tender, isWinner, active) {
  const box = el("div", "checkpoint-card");
  const head = el("div", "head");
  head.append(el("strong", "", `checkpoint ${row.seq}`));
  head.append(el("span", "", row.title));
  head.append(el("span", row.bucket ? `pill ${row.bucket.toLowerCase()}` : "pill", row.bucket || "no proof"));
  if (row.timing) head.append(el("span", `pill ${row.timing.toLowerCase().replace("_", "-")}`, row.timing));
  box.append(head);

  const due = row.due_at ? new Date(row.due_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "-";
  box.append(el("div", "meta", `due ${due} / ${row.submitted_at ? "proof submitted" : "awaiting proof"}`));
  if (row.proof_url) {
    const line = el("div", "meta");
    line.append(document.createTextNode("proof: "));
    const link = el("a", "", row.proof_url);
    link.href = row.proof_url;
    link.target = "_blank";
    link.rel = "noreferrer";
    line.append(link);
    box.append(line);
  }
  if (row.quote) box.append(el("div", "quote", `“${row.quote}”`));

  if (!row.submitted_at && isWinner && active) {
    const label = el("label", "", `Proof URL - ${row.title}`);
    const input = el("input");
    input.id = `proof-${row.seq}`;
    input.placeholder = "https://example.org/proof.html";
    const actions = el("div", "actions");
    const button = el("button", "", "Submit proof");
    button.addEventListener("click", () => {
      const url = input.value.trim();
      if (!/^https?:\/\//i.test(url)) { toast("a full http(s) proof URL is required", true); return; }
      run(`Proof for checkpoint ${row.seq}`, "submit_delivery", [tender.id, row.seq, url]);
    });
    actions.append(button);
    box.append(label, input, actions);
  }
  return box;
}

function certificateBlock(cert) {
  const box = el("div", "certificate");
  box.append(el("h3", "", "Completion certificate"));
  box.append(el("div", "id", cert.certificate_id));
  box.append(el("div", "meta", `decision ${cert.decision} / winner ${short(cert.winner)} / ${cert.checkpoints} checkpoints`));
  const counts = el("div", "counts");
  for (const [number, label] of [[cert.on_time, "on time"], [cert.late, "late"], [cert.missed, "missed"]]) {
    const cell = el("div");
    cell.append(el("b", "", String(number)), el("span", "", label));
    counts.append(cell);
  }
  box.append(counts);
  box.append(el("div", "meta", `validator buckets: ${cert.complete} complete / ${cert.partial} partial / ${cert.missing} missing`));
  return box;
}

async function deliverySection(tender, isBuyer, me) {
  const wrap = el("div", "delivery");
  const title = el("div", "docket-title");
  title.append(el("span", "", "Delivery & acceptance"));
  wrap.append(title);

  let delivery = null;
  try { delivery = await readWithRetry("delivery_of", [tender.id]); } catch { delivery = null; }
  if (!delivery) {
    if (isBuyer) wrap.append(deliveryForm(tender));
    else wrap.append(el("div", "empty", "No delivery plan has been published for this award yet."));
    return wrap;
  }
  wrap.append(el("div", "byline", `status ${delivery.status} / ${delivery.submitted} of ${delivery.checkpoints} proofs / winner ${short(delivery.winner)}`));

  let rows = [];
  let cert = {};
  try {
    rows = await readWithRetry("delivery_checkpoints", [tender.id]);
    cert = await readWithRetry("completion_certificate", [tender.id]);
  } catch {
    wrap.append(el("div", "note", "The checkpoint views could not be read right now."));
    return wrap;
  }
  const isWinner = delivery.winner === me;
  for (const row of rows) wrap.append(checkpointCard(row, tender, isWinner, delivery.status === "active"));

  if (isBuyer && delivery.status === "active") {
    const actions = el("div", "actions");
    const accept = el("button", "primary", "Accept delivery");
    accept.addEventListener("click", () => run("Accept delivery", "accept_delivery", [tender.id]));
    const reject = el("button", "ghost", "Reject delivery");
    reject.addEventListener("click", () => run("Reject delivery", "reject_delivery", [tender.id]));
    actions.append(accept, reject);
    wrap.append(actions);
  }
  if (cert && cert.certificate_id) wrap.append(certificateBlock(cert));
  return wrap;
}

async function renderDetail() {
  if (!selected) return;
  let tender;
  let bids;
  try {
    tender = await readWithRetry("get_tender", [selected]);
    bids = await readWithRetry("bids_of", [selected]);
    try { localStorage.setItem("tenderboard.cache", JSON.stringify({ tender, bids, at: Date.now() })); } catch {}
  } catch (error) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem("tenderboard.cache") || "null"); } catch {}
    if (!cached || !cached.tender || cached.tender.id !== selected) {
      $("detail").replaceChildren(el("div", "card-body empty", String(error.message).slice(0, 160)));
      return;
    }
    tender = cached.tender;
    bids = cached.bids;
    toast("Showing the last readable state: the public RPC refused this read.", true);
  }
  cache = { tender, bids };
  const me = account.address.toLowerCase();
  const isBuyer = tender.buyer === me;

  const body = el("div");
  const head = el("div", "detail-head");
  const when = tender.created_at
    ? new Date(tender.created_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "";
  head.append(el("div", "byline", `notice ${tender.id}${when ? ` / opened ${when}` : ""}`));
  const titleRow = el("div", "row1");
  titleRow.append(el("h2", "", tender.title));
  titleRow.append(el("span", `pill ${tender.status}`, tender.status));
  head.append(titleRow);
  head.append(el("div", "byline", `buyer ${short(tender.buyer)}${isBuyer ? " (you)" : ""} / budget ${tender.budget} / up to ${tender.max_bids} bids`));
  const briefLine = el("div", "brief");
  briefLine.append(document.createTextNode("Brief: "));
  const briefLink = el("a", "", tender.brief_url);
  briefLink.href = tender.brief_url;
  briefLink.target = "_blank";
  briefLink.rel = "noreferrer";
  briefLine.append(briefLink);
  head.append(briefLine);
  body.append(head);

  body.append(el("div", "rubric-title", "The rubric, fixed at open"));
  const [bar, legend] = weightBar(tender.weights);
  body.append(bar, legend);
  body.append(stepper(tender));

  if (tender.winner) {
    const stamp = el("div", "winner");
    stamp.append(el("strong", "", `Awarded to ${short(tender.winner)}`));
    stamp.append(document.createTextNode(` on bid ${tender.winning_bid} with ${tender.winning_total} points`));
    body.append(stamp);
  }

  const docket = el("div", "docket-title");
  docket.append(el("span", "", "The docket"));
  const tally = el("span", "", `${bids.filter((b) => b.revealed).length} opened of ${bids.length}`);
  tally.style.marginLeft = "auto";
  docket.append(tally);
  body.append(docket);

  if (!bids.length) body.append(el("div", "empty", "No bid committed yet."));
  for (const bid of bids) body.append(bidRow(bid, tender, isBuyer));

  const actions = el("div", "actions");
  if (tender.status === "open" && isBuyer) {
    const close = el("button", "primary", "close bidding");
    close.addEventListener("click", () => run("Close bidding", "close_bidding", [tender.id]));
    actions.append(close);
    const cancel = el("button", "ghost", "cancel");
    cancel.addEventListener("click", () => run("Cancel", "cancel_tender", [tender.id]));
    actions.append(cancel);
  }
  if (tender.status === "scoring" && isBuyer) {
    const unscored = bids.filter((b) => b.revealed && !b.bucket).length;
    const award = el("button", "primary", unscored ? "read every bid first" : "award");
    award.disabled = unscored > 0;
    award.addEventListener("click", () => run("Award", "award", [tender.id]));
    actions.append(award);
  }
  if (actions.childElementCount) body.append(actions);

  if (tender.status === "open") body.append(revealForm(tender));
  if (tender.status === "awarded") body.append(await deliverySection(tender, isBuyer, me));

  body.append(
    el("p", "note", `Weights fixed at open: quality ${tender.weights.quality} / price ${tender.weights.price} / delivery ${tender.weights.delivery}. Price score is 100 x cheapest/price, delivery 100 x fastest/days.`)
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

