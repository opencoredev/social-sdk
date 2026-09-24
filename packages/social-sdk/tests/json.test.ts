import { strict as assert } from "node:assert";
import { it } from "node:test";
import { optionsObject } from "../src/cloud/common.js";
import { connectedAccountRef } from "../src/core/index.js";
import { isJsonValue } from "../src/transport/json.js";

const account = connectedAccountRef({ backend: "default", platform: "tiktok", accountId: "a" });

const base = { targetIndex: 0, targetKey: "t0", account, content: { text: "hi" } };

interface Cyclic {
  self?: Cyclic;
}

it("isJsonValue accepts plain JSON and rejects values serialization would change", () => {
  assert.equal(isJsonValue({ a: [1, "b", true, null, { c: 2.5 }], d: undefined }), true);
  assert.equal(isJsonValue(Object.create(null)), true);

  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue({ limit: Number.POSITIVE_INFINITY }), false);
  assert.equal(isJsonValue([Number.NEGATIVE_INFINITY]), false);
  assert.equal(isJsonValue({ at: new Date(0) }), false);
  assert.equal(isJsonValue(new Map()), false);
  assert.equal(isJsonValue({ id: 1n }), false);

  const cyclic: Cyclic = {};
  cyclic.self = cyclic;
  assert.equal(isJsonValue(cyclic), false);
});

it("optionsObject rejects non-finite and non-plain nested options instead of forwarding them", () => {
  assert.deepEqual(
    optionsObject({ ...base, options: { creatorInfo: { maxVideoDurationSeconds: 60 } } }),
    {
      creatorInfo: { maxVideoDurationSeconds: 60 },
    },
  );

  for (const options of [
    { creatorInfo: { maxVideoDurationSeconds: Number.POSITIVE_INFINITY } },
    { creatorInfo: { fetchedAt: new Date(0) } },
  ])
    assert.throws(() => optionsObject({ ...base, options }), { kind: "invalid-response" });
});
