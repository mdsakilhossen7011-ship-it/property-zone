import test from "node:test";
import assert from "node:assert/strict";
import { firestoreValue, firestoreFields, sourceBalance, parseBatchGetResponse } from "../src/index.js";

test("Firestore values decode supported primitive types", () => {
  assert.equal(firestoreValue({ integerValue: "1250" }), 1250);
  assert.equal(firestoreValue({ doubleValue: 12.5 }), 12.5);
  assert.equal(firestoreValue({ stringValue: "BDT" }), "BDT");
  assert.equal(firestoreValue({ booleanValue: true }), true);
  assert.equal(firestoreValue({ nullValue: null }), null);
});

test("Firestore fields decode a document without changing field names", () => {
  assert.deepEqual(firestoreFields({
    schemaVersion: { integerValue: "1" },
    depositAvailablePoisha: { integerValue: "25000" }
  }), { schemaVersion: 1, depositAvailablePoisha: 25000 });
});

test("wallet summary subtracts pending reserve from available balance", () => {
  assert.deepEqual(sourceBalance({
    depositAvailablePoisha: 25000,
    pendingDepositWithdrawalPoisha: 5000
  }, "depositAvailablePoisha", "pendingDepositWithdrawalPoisha"), {
    balancePoisha: 25000,
    pendingWithdrawalPoisha: 5000,
    withdrawablePoisha: 20000
  });
});

test("wallet summary rejects negative, fractional and over-reserved balances", () => {
  for (const ledger of [
    { a: -1, p: 0 },
    { a: 10.5, p: 0 },
    { a: 100, p: -1 },
    { a: 100, p: 101 },
    { a: Number.MAX_SAFE_INTEGER + 1, p: 0 }
  ]) {
    assert.throws(() => sourceBalance(ledger, "a", "p"), /invalid amounts/);
  }
});

test("batchGet parses both JSON arrays and streamed adjacent objects", () => {
  assert.deepEqual(parseBatchGetResponse('[{"found":{"name":"a"}},{"missing":"b"}]'), [
    { found: { name: "a" } }, { missing: "b" }
  ]);
  assert.deepEqual(parseBatchGetResponse('{"found":{"name":"a"}}\\n{"missing":"b"}'), [
    { found: { name: "a" } }, { missing: "b" }
  ]);
  assert.deepEqual(parseBatchGetResponse(""), []);
});
