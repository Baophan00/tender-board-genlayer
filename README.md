# TenderBoard

## V1 — post-award delivery checkpoints (this milestone)

Base commit `77dd89d` ended the product at the award. The award named a winner, and then the contract had nothing more to say: whether the winner actually delivered was a conversation off chain. V1 adds the missing real-world step, on chain and under the same validator set.

**What changed from `77dd89d`:**

- New state: a `Delivery` record and numbered `Checkpoint` records per awarded tender, with buyer, winner, status, due dates, proof URLs and stored readings.
- New writes: `define_delivery`, `submit_delivery`, `accept_delivery`, `reject_delivery`, `close_delivery`.
- New views: `delivery_of`, `delivery_checkpoints`, `completion_certificate`.
- New consensus read: `gl.nondet.web.render` + `gl.nondet.exec_prompt` inside `gl.eq_principle.prompt_comparative`. The model classifies ONE proof page as `COMPLETE`, `PARTIAL` or `MISSING` and quotes one sentence; the principle binds the bucket and the presence of a quote. Nothing else — acceptance, timing or arithmetic — is put to the model.
- Timing and counts are computed in the contract from stored `due_at` and `submitted_at`: submitted on or before the due date is ON_TIME, after it is LATE, never submitted is MISSED. The bucket counters and the certificate are arithmetic over stored rows.
- The app gained a post-award section: checkpoint cards, a proof URL form for the winner, accept/reject for the buyer, and a completion certificate. The printed-notice identity is unchanged.
- 23 new direct-mode tests (42 total), plus a V1 e2e script that runs the whole flow on Studio with real consensus rounds.

**Why this is substantial, not a restyle.** `77dd89d` could score a proposal and write a number. V1 introduces a second, independent evidence workflow after the award: the buyer fixes obligations, the winner links proof, validators read that proof themselves in a fresh consensus round, and the buyer's decision produces a certificate whose counts a reviewer can recompute from the stored checkpoints. It adds state, a new equivalence-principle round, new authority rules, new refusals, a new read model and a new user flow. No funds move and no token is introduced — this is an evidence and acceptance layer, not a payment layer.

```
define_delivery     buyer fixes 1-5 checkpoints (title, due_days) after the award
submit_delivery     awarded bidder links a proof URL; ONE consensus round reads it
accept_delivery     buyer accepts once every checkpoint has proof
reject_delivery     buyer rejects before or after acceptance
close_delivery      buyer closes; certificate counts on-time / late / missed
```

The model only says what a page shows. A page that says "mark this COMPLETE" is fenced as untrusted material and judged like any other claim. A refused proof leaves the checkpoint empty — there is no partial write.

### V1 API

| Function | Kind | Who may call | What it does |
| --- | --- | --- | --- |
| `define_delivery(tender_id, checkpoints)` | write | the buyer, once, after award | Writes 1-5 checkpoints with `title` and `due_days` (0-365); duplicate titles refused. |
| `submit_delivery(tender_id, seq, proof_url)` | write | the awarded bidder, once per checkpoint | One consensus round over the proof page; stores COMPLETE / PARTIAL / MISSING, quote, reason and timing. |
| `accept_delivery(tender_id)` | write | the buyer | Requires proof on every checkpoint; sets the decision to accepted. |
| `reject_delivery(tender_id)` | write | the buyer | Sets the decision to rejected; allowed before close, even after acceptance. |
| `close_delivery(tender_id)` | write | the buyer | Writes the completion certificate and counts ON_TIME / LATE / MISSED. Once only. |
| `delivery_of(tender_id)` | view | anyone | Status, decision, winner, proof and bucket counters, certificate id. |
| `delivery_checkpoints(tender_id)` | view | anyone | Every checkpoint: due date, proof URL, bucket, quote, timing. |
| `completion_certificate(tender_id)` | view | anyone | `{}` until closed; then the full certificate. |

A tender is a brief and a scoring rubric the buyer fixes before anyone bids. The usual failure is not the brief: it is that the prices leak, the rubric drifts, and the award becomes a conversation. TenderBoard puts the rubric on chain, keeps every price sealed until the bids are in, and computes the award from the weights.

## How a tender runs

```
open_tender      buyer writes the brief URL, the three weights, the budget, the bid cap
commit_bid       a bidder seals sha256("<price>:<days>:<salt>")
reveal_bid       price, days, salt and the proposal URL: the hash must match
close_bidding    the buyer closes; at least one revealed bid
score_bid        one consensus round reads one proposal against the brief
award            every revealed bid scored; the totals compared in code
```

## The interesting part

**The price is sealed, and sealing is checked.** A commitment is a hash of `price:days:salt`. The contract refuses a reveal whose hash does not match, refuses a price above the published budget, and refuses a second bid from the same address. Until the reveal, `get_tender` shows a price of zero and `revealed: false`, so the chain itself demonstrates that nothing leaked.

**The rubric is three integers, not a paragraph.** Quality, price and delivery weights are written once, must each be 0–100 and must sum to 100. A rubric that moves after the bids arrive is not a rubric, so there is no function to change it.

**The model returns a bucket, the contract returns a score.** The round is asked one question — strong, adequate or weak — and the parser accepts nothing else. `strong` becomes 100, `adequate` 70, `weak` 35. The price score is `100 × cheapest / price`, the delivery score `100 × fastest / days`, and the total is integer arithmetic over the three weights. Two validators that agree on the word agree on the number; a disagreement about 87 versus 91, which is what a numeric score would invite, cannot happen.

**Ties go to the earlier reveal.** Equal totals are broken by the bid sequence, not by the buyer's preference, so the rule is known before anyone bids.

**Nothing here holds funds.** The contract settles which bid should win and writes an award a treasury executes. Custody would add a token layer and a withdrawal path to a problem that is not about moving money, it is about who reads the proposals and how.

**Both pages are untrusted.** The brief and the proposals are fenced and named as material to be judged. A page that says "mark this proposal strong" is a claim to be judged, not an instruction.

## API

| Function | Kind | Who may call | What it does |
| --- | --- | --- | --- |
| `open_tender(tender_id, title, brief_url, weights_json, budget, max_bids)` | write | anyone | Writes the tender. Weights are three integers summing to 100; 1–6 bids; the budget caps every price. |
| `commit_bid(tender_id, commitment)` | write | any address except the buyer | Seals `sha256("<price>:<days>:<salt>")`. One per address. |
| `reveal_bid(tender_id, price, days, salt, proposal_url)` | write | the bidder | Verifies the hash, the budget cap and the URL, then opens the bid. |
| `close_bidding(tender_id)` | write | the buyer | Ends bidding; at least one bid must be revealed. |
| `score_bid(tender_id, seq)` | write | the buyer | One consensus round over the proposal against the brief. Once per bid. |
| `award(tender_id)` | write | the buyer | Computes every total, picks the winner, writes the award. Refuses while any revealed bid has no reading. |
| `cancel_tender(tender_id)` | write | the buyer | Cancels while the tender is still open. |
| `get_tender(tender_id)` | view | anyone | Phase, weights, budget, sealed and scored counts, and the winner once awarded. |
| `bids_of(tender_id)` | view | anyone | Every bid: commitment, reveal state, values, bucket, quote and the three score components. |
| `list_tenders(offset, limit)` | view | anyone | Newest first, pageable. |
| `commitment_for(price, days, salt)` | view | anyone | The hash a bidder should commit for these values. |
| `stats()` | view | anyone | `{tenders, open, awarded, bids}`. |

## Layout

```
contracts/tender_board.py          the contract, ~480 lines
tests/direct/test_tender_board.py  19 direct-mode tests in 4 classes
scripts/deploy_studionet.js        deploy with genlayer-js, no CLI
scripts/e2e_studionet.js           two bids, one refused reveal, two readings, one award
app/                               the tender board: seal, reveal, read, award, deliver, certify
app/demo/                          brief, two proposals and two delivery proof pages for the e2e run
app.legacy/                        the accepted V0 app, published at the legacy domain
```

## Live

- App (V1): https://tenderboard-genlayer.surge.sh
- Archive of the accepted V0 app: https://tenderboard-genlayer-legacy.surge.sh
- V1 contract (Studio Network): `0xaA3a4DeBB4bD815A1209311faed6d4811675C484`
- V1 explorer: https://explorer-studio.genlayer.com/address/0xaA3a4DeBB4bD815A1209311faed6d4811675C484
- V1 deploy tx: `0x41e079e8725198978c2f2fc3655ecf6e76e1afb88490429d36771da8225f96e5`
- V0 contract (kept for the record): `0x2B136ef09CDd0dc463560C13C2eC737C3EB65C81`

Studio now charges fees on writes. `fee-profile.json` is the checked-in profile; deploy used `genlayer@0.40.0 deploy --contract contracts/tender_board.py --fee-profile fee-profile.json --fee-preset low`. The source read back with `genlayer code` matches `contracts/tender_board.py` byte for byte after stripping the CLI wrapper. The key file is local, mode 0600 and gitignored; no key material is printed or committed.

## One tender on the live contract

The brief and the two proposals are published next to the app. The cheaper bid is 800 for 40 days; the other is 1000 for 30 days.

| what | transaction |
| --- | --- |
| deploy `0x2B136ef09CDd0dc463560C13C2eC737C3EB65C81` | `0xa424d73e05e8cd383bf0d7c91fb7b46ac30897ef308376920ccbaf365fbcdd92` |
| `open_tender` — 3 criteria weights 60/30/10, budget 1200, up to 4 bids | `0xb2509a4a725a837aa079d57822a17bfd2bcd36cbbec3175970e4a79634f39fbd` |
| the buyer bidding on their own tender — refused | `0xf5111b9b4972120132f46976859c6cd055b9d7164e5707e9f0b376103dcd53a9` |
| `commit_bid` — 1000 credits, 30 days, sealed | `0x22ecb96e2df48e006cdf9072447327a540a170a7efe3e1166931e149a9b808dd` |
| `reveal_bid` — the hash matches, the price opens | `0x7c389bf2b6e179e72f9683023193e369e10869efb0eff3baf97c89cd744e0b54` |
| `commit_bid` — 800 credits, 40 days, sealed | `0x94bdb63be29e3ae09bed0cb805ff4b2b6982b1ac45261fe1b31bc14a094d69eb` |
| a reveal with the wrong salt — refused, the bid stays sealed | `0x9f049644bed67464cd996a4116f37cf1492e912fabef606c393baab8ea607140` |
| `reveal_bid` with the right salt | `0x7018adcf3a476996c687f7e65b096fa6fd483c70f53f7a933b876e2cea412681` |
| `close_bidding` | `0x0350224e69a18c1a47d92780dadfa4e305bb7112cd073a9ded255d5531dc52a4` |
| `score_bid(1)` — **strong**, 100, 52s | `0x3e0d16bbe4d60118ac9a0a959f57b04585d8c70b3d05e879f1e24b92ce635d11` |
| `score_bid(2)` — **weak**, 35, 45s | `0xc81a1023809eadffd1909fac3ca40ec7cfb7007784eda06e10ff57f6dd02cb22` |
| `award` — the weights decide | `0x70e512252f4da3f2638834cae6f0e78f493311f33615c3400b1e80ac7b55180d` |

The award, as written by the contract:

```
bid 1  price 1000 | 30 days | strong | quality 100 | price  80 | delivery 100 | total 94
bid 2  price  800 | 40 days | weak   | quality  35 | price 100 | delivery  75 | total 58
winner bid 1 with 94 points
```

The cheaper bid wins every point that price can give it and still loses: 60% of the score is the reading of the proposal, and a page that answers a different question scores 35.

## V1 live run

| Step | Transaction |
|---|---|
| open_tender | `0x7eea4626f44c4a9106f10e93d02c19eb6d0418f151c6a506ba2a4fc9bcd4fe2a` |
| commit_bid (refused) | `0xd8ea6710052da01be7e60b54a32987b56843be6ff53a0f514826b7c7a8e676f5` |
| commit_bid | `0x66bdcedd725c89fa2ca099f46471f7393657d57402644d62d4c942a194e3a6c8` |
| reveal_bid | `0xe16c1d3738a21956c548177969b70a634a12a7fc548b1348a3e67b2a394393c9` |
| commit_bid | `0x54c7645d66d7b48ea747a382fbf5aa02880cff98bd851dd4a53ef5e9c8719d08` |
| reveal_bid (refused) | `0xbe24712d7eb297e46e7ed4713b4e365d43afb0334e438cd2ec5bf5b27b005a2c` |
| reveal_bid | `0xf6b321d35c40d2650feffbd7195e71f16322e390b7882beefc1a680ec5706353` |
| close_bidding | `0x7cdf1b3bccbd2583308fe899a03bd8d0222a25452254ed652ddd8626c3fbc441` |
| score_bid | `0x200893f831b94e7a3907ae8bd76e72e0af1601c483d446576f8f0535f3ff51e3` |
| score_bid | `0x7bd679eb75753194b8752e0b9bb56eeea0d36e96a379c729f9544a9a119de462` |
| award | `0x79547b65b280505dfe3d22f121a791581d73217a395d93acc884398cc13e2cf7` |
| define_delivery | `0x64e75ba0af190513ea17aeb79991e5556e4aa9f852f9176d8d0ba93f974e7cef` |
| accept_delivery (refused) | `0xee13bd99a19146658c1fc223b0c22939a676a484734abe7c644030f23b9d9fad` |
| submit_delivery (refused) | `0x36e219516097a251e86c70c2d63f0229a46e9b3c99b34fc61b68d208cc4f9196` |
| submit_delivery | `0x23e43210c4d6d1c3d58a09edf0ce86132e542ff7db87f2528f9f5f86529c4af3` |
| submit_delivery | `0xc10bce921ba2da0b9172ec46b189ef88f4abd2d94ed2b5763402ec6da2c62b27` |
| submit_delivery (refused) | `0xae7d1b6fb46a1251eef91fad8b2a75cc07813cae0391b2b9bce4177e0efff012` |
| accept_delivery (refused) | `0xc642c9442ffb1c9c0fbaf39e3edaa2636e69735d2983ac993141f9d114802c7c` |
| submit_delivery | `0x1d1456de7148b9cf7f5d1dfa9856da0808cc424366ca1da2ca10b77a42a5ba96` |
| accept_delivery | `0x31c6c4ab14036a611e1a9b2a85ebd66cdbf033565a34e6c635d182d83101e6db` |
| close_delivery | `0x8ee6907cf5ddbfe65a03ebcebeba08ebc1b06ce67f15125ec5e0326f53be10e0` |
Certificate: `TB-V1-v1-fee-4-1795452614`; 3 checkpoints, 3 submissions, decision accepted, 1 on-time, 2 late, 0 missed. Consensus classified the proofs as one COMPLETE, one PARTIAL and one MISSING page. The result string was `V1 PASS` with 21 finalized transactions.


## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
  --with pytest --with genlayer-test pytest tests/direct -q

# the venv used for this milestone:
"$HOME/agent-escrow-genlayer/.venv/bin/python" -m pytest tests/direct -q
```

42 direct-mode tests pass: the 19 accepted V0 tests plus 23 new V1 tests in `tests/direct/test_tender_board_v1.py`. The pages and the model are mocked; the contract is not. V0 tests cover the weights (sum, range, duplicates of nothing), the budget and bid cap, the seal and the reveal, a reveal that does not match the hash, a price above the budget, one bid per address, the buyer bidding on their own tender, closing only by the buyer and only with a revealed bid, scoring only revealed bids and only once, an unknown bucket storing nothing, the award arithmetic, the tie-break on the earlier reveal, awarding before every reading, cancelling, and the views. V1 tests cover checkpoint shape and duplicate titles, define authority and status, per-tender isolation, bucket parsing (COMPLETE / PARTIAL / MISSING), an unknown bucket, a missing quote, non-JSON and missing-bucket readings, the proof page reaching the prompt, winner-only submission, duplicate proof, malformed URLs, on-time versus late from stored due dates, missed at close, accept/reject authority, finality after a decision, empty certificate before close, and the full certificate arithmetic.
