"""Direct-mode tests for TenderBoard.

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
        --with pytest --with genlayer-test pytest tests/direct -q

The brief, the proposals and the model are mocked; the contract is not.
"""

import hashlib
import json

CONTRACT = "contracts/tender_board.py"
PROMPT = r"scoring a tender proposal"
BRIEF = "https://buyer.example.org/brief"
PROPOSAL = "https://bidder.example.org/proposal"
WEIGHTS = {"quality": 60, "price": 30, "delivery": 10}


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def commit_for(price, days, salt):
    return hashlib.sha256(f"{price}:{days}:{salt}".encode("utf-8")).hexdigest()


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def opened(contract, direct_vm, buyer, tender_id="t-1", budget=1000, max_bids=4, weights=None):
    direct_vm.sender = buyer
    return contract.open_tender(
        tender_id, "Docs tooling tender", BRIEF, json.dumps(weights or WEIGHTS), budget, max_bids
    )


def reading(bucket="strong", quote="we ship the whole plan", reason="the plan is specific"):
    return json.dumps({"bucket": bucket, "quote": quote, "reason": reason})


def commit(contract, direct_vm, bidder, price, days, salt, proposal=PROPOSAL, tender_id="t-1"):
    direct_vm.sender = bidder
    return contract.commit_bid(tender_id, commit_for(price, days, salt))


def reveal(contract, direct_vm, bidder, price, days, salt, proposal=PROPOSAL, tender_id="t-1"):
    direct_vm.sender = bidder
    return contract.reveal_bid(tender_id, price, days, salt, proposal)


def mock_round(direct_vm, payload, brief=BRIEF, proposal=PROPOSAL):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"buyer\.example\.org", {"status": 200, "body": "the brief: plan, dates, numbers"})
    direct_vm.mock_web(r"bidder\.example\.org", {"status": 200, "body": "the proposal: a specific plan"})
    direct_vm.mock_llm(PROMPT, payload if isinstance(payload, str) else json.dumps(payload))


def bid(contract, direct_vm, buyer, bidder, price, days, salt, bucket="strong", build=False):
    """Commit, reveal and score one bid, in the order the contract requires."""
    commit(contract, direct_vm, bidder, price, days, salt)
    reveal(contract, direct_vm, bidder, price, days, salt)
    if build:
        direct_vm.sender = buyer
        contract.close_bidding("t-1")
    if build:
        seq = contract.bids_of("t-1")[-1]["seq"]
        mock_round(direct_vm, reading(bucket))
        direct_vm.sender = buyer
        return contract.score_bid("t-1", seq)
    return None


class TestOpen:
    def test_the_rubric_and_the_budget_are_written_once(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        out = opened(contract, direct_vm, direct_alice)

        assert out["tender_id"] == "t-1"
        assert out["buyer"] == who(direct_alice)
        assert out["weights"] == WEIGHTS
        assert out["budget"] == 1000
        assert out["max_bids"] == 4
        assert out["status"] == "open"

        tender = contract.get_tender("t-1")
        assert tender["brief_url"] == BRIEF
        assert tender["bids"] == 0 and tender["scored"] == 0
        assert contract.stats() == {"tenders": 1, "open": 1, "awarded": 0, "bids": 0}

    def test_the_weights_must_be_whole_and_sum_to_one_hundred(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice

        with direct_vm.expect_revert("must sum to 100"):
            contract.open_tender("a", "T", BRIEF, json.dumps({"quality": 50, "price": 30, "delivery": 10}), 100, 2)
        with direct_vm.expect_revert("must be between 0 and 100"):
            contract.open_tender("b", "T", BRIEF, json.dumps({"quality": 120, "price": -20, "delivery": 0}), 100, 2)
        with direct_vm.expect_revert("must be a whole number"):
            contract.open_tender("c", "T", BRIEF, json.dumps({"quality": 60.5, "price": 30, "delivery": 9.5}), 100, 2)
        with direct_vm.expect_revert("budget must be a positive"):
            contract.open_tender("d", "T", BRIEF, json.dumps(WEIGHTS), 0, 2)
        with direct_vm.expect_revert("1 to 6 bids"):
            contract.open_tender("e", "T", BRIEF, json.dumps(WEIGHTS), 100, 7)
        with direct_vm.expect_revert("is taken"):
            opened(contract, direct_vm, direct_alice)
            opened(contract, direct_vm, direct_alice)

    def test_the_brief_must_be_a_url(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("not an http"):
            contract.open_tender("t", "T", "buyer.example.org/brief", json.dumps(WEIGHTS), 100, 2)


class TestBidding:
    def test_a_commitment_stays_sealed_and_a_reveal_opens_it(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)

        out = commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        assert out["revealed"] is False and out["seq"] == 1

        sealed = contract.bids_of("t-1")[0]
        assert sealed["revealed"] is False
        assert sealed["price"] == 0
        assert sealed["commitment"] == commit_for(900, 30, "salt-1234")

        opened_bid = reveal(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        assert opened_bid["revealed"] is True
        assert opened_bid["price"] == 900
        assert opened_bid["days"] == 30
        assert opened_bid["proposal_url"] == PROPOSAL
        assert contract.get_tender("t-1")["bids"] == 1

    def test_a_reveal_that_does_not_match_the_commitment_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")

        with direct_vm.expect_revert("does not match the commitment"):
            reveal(contract, direct_vm, direct_bob, 899, 30, "salt-1234")
        with direct_vm.expect_revert("does not match the commitment"):
            reveal(contract, direct_vm, direct_bob, 900, 30, "salt-9999")
        assert contract.bids_of("t-1")[0]["revealed"] is False

    def test_the_price_is_capped_by_the_published_budget(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, budget=1000)
        commit(contract, direct_vm, direct_bob, 1200, 30, "salt-1234")

        with direct_vm.expect_revert("above the published budget"):
            reveal(contract, direct_vm, direct_bob, 1200, 30, "salt-1234")

    def test_one_bid_per_address_and_the_buyer_cannot_bid(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)

        with direct_vm.expect_revert("buyer cannot bid"):
            commit(contract, direct_vm, direct_alice, 900, 30, "salt-1234")

        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        with direct_vm.expect_revert("already committed a bid"):
            commit(contract, direct_vm, direct_bob, 800, 20, "salt-5678")

    def test_the_bid_cap_is_enforced(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, max_bids=1)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")

        carol = bytes([0x44] * 20)
        with direct_vm.expect_revert("at most 1 bids"):
            commit(contract, direct_vm, carol, 800, 20, "salt-5678")

    def test_a_reveal_needs_a_commitment_first(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("committed no bid"):
            contract.reveal_bid("t-1", 900, 30, "salt-1234", PROPOSAL)


class TestScoring:
    def test_the_buyer_closes_and_scores_every_revealed_bid_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        reveal(contract, direct_vm, direct_bob, 900, 30, "salt-1234")

        with direct_vm.expect_revert("only the buyer closes"):
            direct_vm.sender = direct_bob
            contract.close_bidding("t-1")

        direct_vm.sender = direct_alice
        closed = contract.close_bidding("t-1")
        assert closed["status"] == "scoring" and closed["revealed"] == 1

        mock_round(direct_vm, reading("strong"))
        direct_vm.sender = direct_alice
        out = contract.score_bid("t-1", 1)
        assert out["bucket"] == "strong"
        assert out["quality"] == 100
        assert out["quote"] == "we ship the whole plan"

        mock_round(direct_vm, reading("weak"))
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("already scored"):
            contract.score_bid("t-1", 1)

    def test_an_unknown_bucket_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        reveal(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        direct_vm.sender = direct_alice
        contract.close_bidding("t-1")

        mock_round(direct_vm, {"bucket": "excellent", "quote": "", "reason": ""})
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("not strong, adequate or weak"):
            contract.score_bid("t-1", 1)
        assert contract.bids_of("t-1")[0]["bucket"] == ""
        assert contract.get_tender("t-1")["scored"] == 0

    def test_only_the_buyer_scores_and_only_revealed_bids(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        reveal(contract, direct_vm, direct_bob, 900, 30, "salt-1234")
        carol = bytes([0x44] * 20)
        direct_vm.sender = carol
        contract.commit_bid("t-1", commit_for(800, 40, "salt-9999"))

        direct_vm.sender = direct_alice
        contract.close_bidding("t-1")

        mock_round(direct_vm, reading())
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the buyer scores"):
            contract.score_bid("t-1", 1)

        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("was never revealed"):
            contract.score_bid("t-1", 2)


class TestAward:
    def test_the_cheapest_good_bid_beats_the_expensive_great_one(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 1000, 30, "salt-aaaa")
        reveal(contract, direct_vm, direct_bob, 1000, 30, "salt-aaaa")
        carol = bytes([0x44] * 20)
        commit(contract, direct_vm, carol, 800, 40, "salt-bbbb")
        reveal(contract, direct_vm, carol, 800, 40, "salt-bbbb")

        direct_vm.sender = direct_alice
        contract.close_bidding("t-1")

        mock_round(direct_vm, reading("strong"))
        direct_vm.sender = direct_alice
        contract.score_bid("t-1", 1)

        mock_round(direct_vm, reading("adequate"))
        direct_vm.sender = direct_alice
        contract.score_bid("t-1", 2)

        direct_vm.sender = direct_alice
        awarded = contract.award("t-1")

        assert awarded["status"] == "awarded"
        assert awarded["winner"] == who(direct_bob)
        assert awarded["winning_total"] == 94

        rows = {r["seq"]: r for r in awarded["bids"]}
        assert rows[1]["quality"] == 100 and rows[1]["price_score"] == 80 and rows[1]["delivery_score"] == 100
        assert rows[1]["total"] == 94
        assert rows[2]["quality"] == 70 and rows[2]["price_score"] == 100 and rows[2]["delivery_score"] == 75
        assert rows[2]["total"] == 79
        assert contract.stats()["awarded"] == 1

    def test_a_tie_goes_to_the_earlier_reveal(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-aaaa")
        reveal(contract, direct_vm, direct_bob, 900, 30, "salt-aaaa")
        carol = bytes([0x44] * 20)
        commit(contract, direct_vm, carol, 900, 30, "salt-bbbb")
        reveal(contract, direct_vm, carol, 900, 30, "salt-bbbb")

        direct_vm.sender = direct_alice
        contract.close_bidding("t-1")
        mock_round(direct_vm, reading("strong"))
        direct_vm.sender = direct_alice
        contract.score_bid("t-1", 1)
        mock_round(direct_vm, reading("strong"))
        direct_vm.sender = direct_alice
        contract.score_bid("t-1", 2)

        awarded = contract.award("t-1")
        assert awarded["winner"] == who(direct_bob)
        assert awarded["winning_bid"] == 1

    def test_award_waits_for_every_reading(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        commit(contract, direct_vm, direct_bob, 900, 30, "salt-aaaa")
        reveal(contract, direct_vm, direct_bob, 900, 30, "salt-aaaa")
        carol = bytes([0x44] * 20)
        commit(contract, direct_vm, carol, 850, 25, "salt-bbbb")
        reveal(contract, direct_vm, carol, 850, 25, "salt-bbbb")

        direct_vm.sender = direct_alice
        contract.close_bidding("t-1")
        mock_round(direct_vm, reading("strong"))
        direct_vm.sender = direct_alice
        contract.score_bid("t-1", 1)

        with direct_vm.expect_revert("has no reading yet"):
            contract.award("t-1")

    def test_closing_needs_a_revealed_bid_and_open_needs_both_steps(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("no bid was revealed"):
            contract.close_bidding("t-1")

        commit(contract, direct_vm, direct_bob, 900, 30, "salt-aaaa")
        with direct_vm.expect_revert("no bid was revealed"):
            direct_vm.sender = direct_alice
            contract.close_bidding("t-1")

    def test_cancel_only_while_open(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)

        with direct_vm.expect_revert("only the buyer cancels"):
            direct_vm.sender = direct_bob
            contract.cancel_tender("t-1")

        direct_vm.sender = direct_alice
        out = contract.cancel_tender("t-1")
        assert out["status"] == "cancelled"
        with direct_vm.expect_revert("cannot be cancelled"):
            contract.cancel_tender("t-1")

    def test_tenders_are_listed_newest_first(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice, "t-a")
        direct_vm.sender = direct_alice
        contract.open_tender("t-b", "Second", BRIEF, json.dumps(WEIGHTS), 500, 2)

        listed = contract.list_tenders(0, 10)
        assert [t["id"] for t in listed] == ["t-b", "t-a"]
        assert listed[0]["budget"] == 500

    def test_the_commitment_helper_matches_the_reveal_check(self, direct_vm, direct_deploy, direct_alice):
        contract = deploy(direct_deploy)
        opened(contract, direct_vm, direct_alice)
        assert contract.commitment_for(900, 30, "salt-1234") == commit_for(900, 30, "salt-1234")
