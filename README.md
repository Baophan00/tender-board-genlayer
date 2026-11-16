# TenderBoard

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
app/                               the tender board: seal, reveal, read, award
app/demo/                          the brief and two proposals the e2e run uses
```

## Live

- App: https://tenderboard-genlayer.surge.sh
- Contract (Studio Network): `0x2B136ef09CDd0dc463560C13C2eC737C3EB65C81`
- Explorer: https://explorer-studio.genlayer.com/address/0x2B136ef09CDd0dc463560C13C2eC737C3EB65C81

## Tests

```
env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
  --with pytest --with genlayer-test pytest tests/direct -q
```

19 direct-mode tests. The pages and the model are mocked; the contract is not. They cover the weights (sum, range, duplicates of nothing), the budget and bid cap, the seal and the reveal, a reveal that does not match the hash, a price above the budget, one bid per address, the buyer bidding on their own tender, closing only by the buyer and only with a revealed bid, scoring only revealed bids and only once, an unknown bucket storing nothing, the award arithmetic, the tie-break on the earlier reveal, awarding before every reading, cancelling, and the views.
