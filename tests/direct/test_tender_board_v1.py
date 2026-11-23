"""Direct-mode tests for the TenderBoard V1 delta.

    "$HOME/agent-escrow-genlayer/.venv/bin/python" -m pytest tests/direct -q

Only the pages and the model are mocked. The contract is not: checkpoint
rules, bucket parsing, refusals, timing, authority and certificate arithmetic
all run through the real contract in direct mode.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone

CONTRACT = "contracts/tender_board.py"
PROMPT_SCORE = r"scoring a tender proposal"
PROMPT_PROOF = r"delivery evidence reviewer"
BRIEF = "https://buyer.example.org/brief"
PROPOSAL_A = "https://bidder.example.org/proposal-a"
PROPOSAL_B = "https://bidder.example.org/proposal-b"
PROOF = "https://proof.example.org/delivery.html"
PAGE_BODY = "The log states: the handover was signed off and delivered."
WEIGHTS = {"quality": 60, "price": 30, "delivery": 10}
TID = "v1-1"
CP = [
    {"title": "Design sign-off", "due_days": 10},
    {"title": "Handover", "due_days": 0},
]


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def digest(price, days, salt):
    return hashlib.sha256(f"{price}:{days}:{salt}".encode("utf-8")).hexdigest()


def mock_score(direct_vm, bucket):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"buyer\.example\.org", {"status": 200, "body": "the brief: plan, dates, numbers"})
    direct_vm.mock_web(r"bidder\.example\.org", {"status": 200, "body": "the proposal: a specific plan"})
    direct_vm.mock_llm(
        PROMPT_SCORE,
        json.dumps({"bucket": bucket, "quote": "we ship the whole plan", "reason": "specific"}),
    )


def mock_proof(direct_vm, bucket, quote="the handover was signed off", anchor=PROMPT_PROOF):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r"proof\.example\.org", {"status": 200, "body": PAGE_BODY})
    direct_vm.mock_llm(
        anchor,
        json.dumps({"bucket": bucket, "quote": quote, "reason": "the page states the result"}),
    )


def award_existing(contract, direct_vm, buyer, alice, bob, tid=TID):
    direct_vm.sender = buyer
    contract.open_tender(tid, "Delivery tender", BRIEF, json.dumps(WEIGHTS), 1000, 2)

    direct_vm.sender = alice
    contract.commit_bid(tid, digest(900, 30, "salt-alpha-1"))
    contract.reveal_bid(tid, 900, 30, "salt-alpha-1", PROPOSAL_A)
    direct_vm.sender = bob
    contract.commit_bid(tid, digest(800, 40, "salt-beta-22"))
    contract.reveal_bid(tid, 800, 40, "salt-beta-22", PROPOSAL_B)

    direct_vm.sender = buyer
    contract.close_bidding(tid)
    mock_score(direct_vm, "strong")
    direct_vm.sender = buyer
    contract.score_bid(tid, 1)
    mock_score(direct_vm, "weak")
    direct_vm.sender = buyer
    contract.score_bid(tid, 2)
    out = contract.award(tid)
    assert out["winner"] == who(alice)
    return contract


def awarded(direct_deploy, direct_vm, buyer, alice, bob, tid=TID):
    return award_existing(direct_deploy(CONTRACT), direct_vm, buyer, alice, bob, tid)


def defined(contract, direct_vm, buyer, items=None, tid=TID):
    direct_vm.sender = buyer
    return contract.define_delivery(tid, json.dumps(CP if items is None else items))


def submitted(contract, direct_vm, winner, seq, bucket, proof=PROOF, tid=TID):
    mock_proof(direct_vm, bucket)
    direct_vm.sender = winner
    return contract.submit_delivery(tid, seq, proof)


class TestDeliveryDefinition:
    def test_only_the_buyer_defines_and_only_after_award(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the buyer defines"):
            defined(contract, direct_vm, direct_bob)

        direct_vm.sender = direct_alice
        contract.open_tender("v1-open", "Not awarded", BRIEF, json.dumps(WEIGHTS), 1000, 2)
        with direct_vm.expect_revert("only an awarded tender"):
            defined(contract, direct_vm, direct_alice, tid="v1-open")

    def test_checkpoints_are_stored_with_due_dates_and_read_back(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        out = defined(contract, direct_vm, direct_alice)

        assert out["status"] == "active" and out["winner"] == who(direct_bob)
        assert out["checkpoints"] == 2 and out["submitted"] == 0
        assert out["on_time"] == 0 and out["late"] == 0 and out["missed"] == 0
        assert contract.delivery_of(TID) == out
        rows = contract.delivery_checkpoints(TID)
        assert [r["seq"] for r in rows] == [1, 2]
        assert [r["title"] for r in rows] == ["Design sign-off", "Handover"]
        assert rows[0]["due_at"] - rows[0]["created_at"] == 10 * 86400
        assert rows[1]["due_at"] - rows[1]["created_at"] == 0
        assert rows[0]["bucket"] == "" and rows[0]["submitted_at"] == 0
        assert rows[0]["timing"] == ""

    def test_a_second_define_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        with direct_vm.expect_revert("already defined"):
            defined(contract, direct_vm, direct_alice, [{"title": "Another", "due_days": 1}])

    def test_checkpoint_shape_is_validated(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("at least one checkpoint"):
            contract.define_delivery(TID, json.dumps([]))
        with direct_vm.expect_revert("at most 5 checkpoints"):
            contract.define_delivery(TID, json.dumps([{"title": f"C{i}", "due_days": 1} for i in range(6)]))
        with direct_vm.expect_revert("needs a title"):
            contract.define_delivery(TID, json.dumps([{"title": "  ", "due_days": 1}]))
        with direct_vm.expect_revert("due_days must be between 0 and 365"):
            contract.define_delivery(TID, json.dumps([{"title": "A", "due_days": 366}]))
        with direct_vm.expect_revert("whole number of days"):
            contract.define_delivery(TID, json.dumps([{"title": "A", "due_days": 1.5}]))
        with direct_vm.expect_revert("not valid JSON"):
            contract.define_delivery(TID, "{not json")

    def test_duplicate_checkpoint_titles_are_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("duplicate checkpoint title"):
            contract.define_delivery(TID, json.dumps([
                {"title": "sign off", "due_days": 1}, {"title": "Sign Off", "due_days": 2},
            ]))


class TestProofReading:
    def test_one_round_parses_each_bucket_and_keeps_the_quote(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)

        first = submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        assert first["bucket"] == "COMPLETE" and first["timing"] == "ON_TIME"
        assert first["quote"] == "the handover was signed off"
        assert first["proof_url"] == PROOF and first["submitted_at"] > 0

        second = submitted(contract, direct_vm, direct_bob, 2, "PARTIAL")
        assert second["bucket"] == "PARTIAL"
        rows = {r["seq"]: r for r in contract.delivery_checkpoints(TID)}
        assert rows[1]["bucket"] == "COMPLETE" and rows[2]["bucket"] == "PARTIAL"
        state = contract.delivery_of(TID)
        assert state["submitted"] == 2 and state["complete"] == 1 and state["partial"] == 1
        assert state["missing"] == 0

    def test_the_page_body_reaches_the_consensus_prompt(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        mock_proof(direct_vm, "COMPLETE", anchor=r"signed off and delivered")
        direct_vm.sender = direct_bob
        out = contract.submit_delivery(TID, 1, PROOF)
        assert out["bucket"] == "COMPLETE"

    def test_an_unknown_bucket_is_refused_and_stores_nothing(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        mock_proof(direct_vm, "DONE")
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("which is not COMPLETE, PARTIAL or MISSING"):
            contract.submit_delivery(TID, 1, PROOF)
        row = contract.delivery_checkpoints(TID)[0]
        assert row["bucket"] == "" and row["submitted_at"] == 0 and row["proof_url"] == ""
        assert contract.delivery_of(TID)["submitted"] == 0

    def test_a_reading_with_no_quote_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"proof\.example\.org", {"status": 200, "body": PAGE_BODY})
        direct_vm.mock_llm(PROMPT_PROOF, json.dumps({"bucket": "COMPLETE", "quote": "  ", "reason": "x"}))
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("did not quote the proof"):
            contract.submit_delivery(TID, 1, PROOF)
        assert contract.delivery_checkpoints(TID)[0]["submitted_at"] == 0

    def test_non_json_reading_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"proof\.example\.org", {"status": 200, "body": PAGE_BODY})
        direct_vm.mock_llm(PROMPT_PROOF, "not json at all")
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("did not return JSON"):
            contract.submit_delivery(TID, 1, PROOF)

    def test_a_missing_bucket_from_the_model_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r"proof\.example\.org", {"status": 200, "body": PAGE_BODY})
        direct_vm.mock_llm(PROMPT_PROOF, json.dumps({"quote": "a quote", "reason": "x"}))
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("which is not COMPLETE"):
            contract.submit_delivery(TID, 1, PROOF)


class TestProofGuards:
    def test_only_the_awarded_bidder_submits_proof(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        mock_proof(direct_vm, "COMPLETE")
        direct_vm.sender = direct_alice  # buyer, not the winner
        with direct_vm.expect_revert("only the awarded bidder"):
            contract.submit_delivery(TID, 1, PROOF)
        mock_proof(direct_vm, "COMPLETE")
        direct_vm.sender = carol  # losing bidder
        with direct_vm.expect_revert("only the awarded bidder"):
            contract.submit_delivery(TID, 1, PROOF)

    def test_a_second_proof_for_one_checkpoint_is_refused(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("already has a proof"):
            contract.submit_delivery(TID, 1, "https://proof.example.org/again.html")
        rows = contract.delivery_checkpoints(TID)
        assert rows[0]["bucket"] == "COMPLETE" and rows[0]["proof_url"] == PROOF
        assert contract.delivery_of(TID)["submitted"] == 1

    def test_proof_url_and_checkpoint_number_are_checked(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("not an http"):
            contract.submit_delivery(TID, 1, "proof.example.org/ page")
        with direct_vm.expect_revert("does not exist"):
            contract.submit_delivery(TID, 9, PROOF)
        with direct_vm.expect_revert("must be a number"):
            contract.submit_delivery(TID, True, PROOF)

    def test_proof_cannot_follow_a_buyer_decision(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice, [{"title": "Only", "due_days": 1}])
        submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        direct_vm.sender = direct_alice
        contract.accept_delivery(TID)
        mock_proof(direct_vm, "COMPLETE")
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("proof is no longer accepted"):
            contract.submit_delivery(TID, 1, PROOF)


class TestTimingAndDecision:
    def test_late_is_computed_from_the_stored_due_date(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        later = datetime.now(timezone.utc) + timedelta(days=2)
        direct_vm.warp(later.isoformat())
        out = submitted(contract, direct_vm, direct_bob, 2, "PARTIAL")
        assert out["timing"] == "LATE"
        assert out["submitted_at"] > out["due_at"]

    def test_an_unsubmitted_checkpoint_is_missed_at_close(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("must accept or reject"):
            contract.close_delivery(TID)
        contract.reject_delivery(TID)
        cert = contract.close_delivery(TID)
        rows = {r["seq"]: r for r in contract.delivery_checkpoints(TID)}
        assert rows[2]["timing"] == "MISSED" and rows[2]["submitted_at"] == 0
        assert cert["missed"] == 1 and cert["on_time"] == 1 and cert["late"] == 0

    def test_only_the_buyer_accepts_and_every_checkpoint_needs_proof(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the buyer accepts"):
            contract.accept_delivery(TID)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("has no proof yet"):
            contract.accept_delivery(TID)
        submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("has no proof yet"):
            contract.accept_delivery(TID)
        submitted(contract, direct_vm, direct_bob, 2, "MISSING")
        direct_vm.sender = direct_alice
        out = contract.accept_delivery(TID)
        assert out["status"] == "accepted" and out["decision"] == "accepted"

    def test_only_the_buyer_rejects_and_acceptance_is_final(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the buyer rejects"):
            contract.reject_delivery(TID)
        direct_vm.sender = direct_alice
        out = contract.reject_delivery(TID)
        assert out["status"] == "rejected" and out["decision"] == "rejected"
        with direct_vm.expect_revert("cannot be accepted"):
            contract.accept_delivery(TID)
        with direct_vm.expect_revert("cannot be rejected"):
            contract.reject_delivery(TID)

    def test_a_rejected_delivery_can_still_be_closed_once(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice, [{"title": "Only", "due_days": 1}])
        direct_vm.sender = direct_alice
        contract.reject_delivery(TID)
        cert = contract.close_delivery(TID)
        assert cert["decision"] == "rejected" and cert["submitted"] == 0
        assert cert["checkpoints"] == 1 and cert["missed"] == 1
        assert contract.delivery_of(TID)["status"] == "closed"
        with direct_vm.expect_revert("must accept or reject"):
            contract.close_delivery(TID)


class TestCertificate:
    def test_certificate_arithmetic_counts_on_time_late_missed_and_buckets(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice, [
            {"title": "On time", "due_days": 10},
            {"title": "Late", "due_days": 0},
            {"title": "Never", "due_days": 0},
        ])
        submitted(contract, direct_vm, direct_bob, 1, "COMPLETE")
        direct_vm.warp((datetime.now(timezone.utc) + timedelta(days=2)).isoformat())
        submitted(contract, direct_vm, direct_bob, 2, "PARTIAL")
        direct_vm.sender = direct_alice
        contract.reject_delivery(TID)
        cert = contract.close_delivery(TID)

        assert cert["decision"] == "rejected"
        assert cert["checkpoints"] == 3 and cert["submitted"] == 2
        assert cert["complete"] == 1 and cert["partial"] == 1 and cert["missing"] == 0
        assert cert["on_time"] == 1 and cert["late"] == 1 and cert["missed"] == 1
        assert cert["winner"] == who(direct_bob)
        assert cert["certificate_id"] == f"TB-V1-{TID}-{cert['closed_at']}"
        assert cert["closed_at"] > 0

    def test_certificate_view_is_empty_until_close_then_matches(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol)
        defined(contract, direct_vm, direct_alice, [{"title": "Only", "due_days": 1}])
        assert contract.completion_certificate(TID) == {}
        submitted(contract, direct_vm, direct_bob, 1, "MISSING")
        assert contract.delivery_of(TID)["missing"] == 1
        assert contract.completion_certificate(TID) == {}
        direct_vm.sender = direct_alice
        contract.accept_delivery(TID)
        cert = contract.close_delivery(TID)
        assert contract.completion_certificate(TID) == cert
        assert cert["missing"] == 1 and cert["on_time"] == 1
        assert cert["decision"] == "accepted"

    def test_each_tender_has_its_own_delivery(self, direct_vm, direct_deploy, direct_alice, direct_bob):
        carol = bytes([0x44] * 20)
        contract = awarded(direct_deploy, direct_vm, direct_alice, direct_bob, carol, tid="v1-a")
        defined(contract, direct_vm, direct_alice, tid="v1-a")
        award_existing(contract, direct_vm, direct_alice, direct_bob, carol, tid="v1-b")
        award_existing(contract, direct_vm, direct_alice, carol, bytes([0x55] * 20), tid="v1-c")
        defined(contract, direct_vm, direct_alice, [{"title": "Only", "due_days": 1}], tid="v1-c")
        assert contract.delivery_of("v1-a")["checkpoints"] == 2
        assert contract.delivery_of("v1-c")["checkpoints"] == 1
        assert contract.delivery_of("v1-a")["tender_id"] == "v1-a"
