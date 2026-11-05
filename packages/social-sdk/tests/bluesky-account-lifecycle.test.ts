import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  createBlueskyAccount,
  deleteBlueskyAccount,
  deleteBlueskySession,
  describeBlueskyServer,
  requestBlueskyPasswordReset,
  resetBlueskyPassword,
} from "../src/platforms/bluesky.js";
import { account, did, empty, harness, json, recorder } from "./bluesky-harness.js";

const invalid = { name: "SocialError", code: "invalid_input" };

const service = "https://pds.example";

describe("Bluesky sign-out and app passwords", () => {
  it("signs out with com.atproto.server.deleteSession using the refresh token", async () => {
    const { calls, fetch } = recorder(() => empty());

    await deleteBlueskySession({ service, refreshJwt: "fixture-refresh", fetch });

    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.deleteSession");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer fixture-refresh");
    assert.equal(calls[0]?.raw, undefined);

    await assert.rejects(deleteBlueskySession({ service, refreshJwt: "", fetch }), invalid);
    assert.equal(calls.length, 1);
  });

  it("creates, lists, and revokes with com.atproto.server.createAppPassword", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("createAppPassword"))
        return json({
          name: "scheduler",
          password: "fixture-app-password",
          createdAt: "2026-11-04T00:00:00.000Z",
          privileged: false,
        });

      if (url.pathname.endsWith("listAppPasswords"))
        return json({ passwords: [{ name: "scheduler", createdAt: "2026-11-04T00:00:00.000Z" }] });

      return empty();
    });

    const created = await native.createAppPassword({
      account,
      name: "scheduler",
      privileged: false,
    });

    assert.equal(created.password, "fixture-app-password");
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.createAppPassword");
    assert.deepEqual(calls[0]?.body, { name: "scheduler", privileged: false });

    assert.deepEqual(await native.listAppPasswords({ account }), [
      { name: "scheduler", createdAt: "2026-11-04T00:00:00.000Z" },
    ]);
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.server.listAppPasswords");

    await native.revokeAppPassword({ account, name: "scheduler" });
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.server.revokeAppPassword");
    assert.deepEqual(calls[2]?.body, { name: "scheduler" });

    await assert.rejects(native.createAppPassword({ account, name: " " }), invalid);
    assert.equal(calls.length, 3);
  });
});

describe("Bluesky handle and account lifecycle", () => {
  it("changes the handle with com.atproto.identity.updateHandle and refreshes identity", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("refreshIdentity")
        ? json({ did, handle: "alice.example.com", didDoc: { id: did } })
        : empty(),
    );

    await native.updateHandle({ account, handle: "Alice.Example.com" });
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.identity.updateHandle");
    assert.deepEqual(calls[0]?.body, { handle: "alice.example.com" });

    const identity = await native.refreshIdentity({ account, identifier: did });
    assert.equal(identity.handle, "alice.example.com");
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.identity.refreshIdentity");

    await assert.rejects(native.updateHandle({ account, handle: "not a handle" }), invalid);
    assert.equal(calls.length, 2);
  });

  it("deactivates with com.atproto.server.deactivateAccount and runs the email flows", async () => {
    const { native, calls } = harness(({ url }) =>
      url.pathname.endsWith("requestEmailUpdate") ? json({ tokenRequired: true }) : empty(),
    );

    await native.deactivateAccount({ account, deleteAfter: "2026-12-01T00:00:00.000Z" });
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.deactivateAccount");
    assert.deepEqual(calls[0]?.body, { deleteAfter: "2026-12-01T00:00:00.000Z" });

    await native.activateAccount({ account });
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.server.activateAccount");

    await native.requestAccountDelete({ account });
    await native.requestEmailConfirmation({ account });
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.server.requestAccountDelete");
    assert.equal(calls[3]?.url.pathname, "/xrpc/com.atproto.server.requestEmailConfirmation");

    await native.confirmEmail({ account, email: "person@example.com", token: "AAAAA-BBBBB" });
    assert.deepEqual(calls[4]?.body, { email: "person@example.com", token: "AAAAA-BBBBB" });

    assert.deepEqual(await native.requestEmailUpdate({ account }), { tokenRequired: true });
    assert.equal(calls[5]?.method, "POST");

    await native.updateEmail({ account, email: "new@example.com", token: "CCCCC-DDDDD" });
    assert.deepEqual(calls[6]?.body, { email: "new@example.com", token: "CCCCC-DDDDD" });

    await assert.rejects(native.deactivateAccount({ account, deleteAfter: "soon" }), invalid);
    assert.equal(calls.length, 7);
  });

  it("resets passwords and deletes accounts without an adapter session", async () => {
    const { calls, fetch } = recorder(() => empty());

    await requestBlueskyPasswordReset({ service, email: "person@example.com", fetch });
    await resetBlueskyPassword({ service, token: "EEEEE-FFFFF", password: "fixture-new", fetch });
    await deleteBlueskyAccount({
      service,
      did,
      password: "fixture-password",
      token: "GGGGG-HHHHH",
      fetch,
    });

    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.requestPasswordReset");
    assert.deepEqual(calls[0]?.body, { email: "person@example.com" });
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.server.resetPassword");
    assert.equal(calls[2]?.url.pathname, "/xrpc/com.atproto.server.deleteAccount");
    assert.deepEqual(calls[2]?.body, { did, password: "fixture-password", token: "GGGGG-HHHHH" });
    assert.equal(calls[2]?.headers.get("authorization"), null);

    await assert.rejects(
      deleteBlueskyAccount({ service, did: "alice", password: "x", token: "y", fetch }),
      invalid,
    );
    assert.equal(calls.length, 3);
  });
});

describe("Bluesky account migration", () => {
  it("creates an account on a new PDS with com.atproto.server.createAccount and service auth", async () => {
    const { calls, fetch } = recorder(({ url }) =>
      url.pathname.endsWith("describeServer")
        ? json({ did: "did:web:new-pds.example", availableUserDomains: [".new-pds.example"] })
        : json({
            did,
            handle: "alice.new-pds.example",
            accessJwt: "fixture-access",
            refreshJwt: "fixture-refresh",
          }),
    );

    const server = await describeBlueskyServer({ service: "https://new-pds.example", fetch });
    assert.equal(server.did, "did:web:new-pds.example");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.url.pathname, "/xrpc/com.atproto.server.describeServer");

    const session = await createBlueskyAccount({
      service: "https://new-pds.example",
      handle: "alice.new-pds.example",
      email: "person@example.com",
      password: "fixture-password",
      did,
      serviceAuthToken: "fixture-service-auth",
      fetch,
    });

    assert.equal(session.did, did);
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.server.createAccount");
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer fixture-service-auth");
    assert.deepEqual(calls[1]?.body, {
      handle: "alice.new-pds.example",
      email: "person@example.com",
      password: "fixture-password",
      did,
    });
  });

  it("mints service auth, moves the repository with importRepo, and signs PLC operations", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("getServiceAuth")) return json({ token: "fixture-service-auth" });

      if (url.pathname.endsWith("listMissingBlobs"))
        return json({
          blobs: [{ cid: "bafkreimissing", recordUri: `at://${did}/app.bsky.feed.post/1` }],
          cursor: "b2",
        });

      if (url.pathname.endsWith("getRecommendedDidCredentials"))
        return json({ rotationKeys: ["did:key:zNew"], alsoKnownAs: ["at://alice.test"] });

      if (url.pathname.endsWith("signPlcOperation"))
        return json({ operation: { type: "plc_operation", sig: "fixture" } });

      return empty();
    });

    const token = await native.getServiceAuth({
      account,
      aud: "did:web:new-pds.example",
      lxm: "com.atproto.server.createAccount",
      expiresInSeconds: 60,
    });

    assert.equal(token, "fixture-service-auth");
    assert.equal(calls[0]?.url.searchParams.get("aud"), "did:web:new-pds.example");
    assert.equal(calls[0]?.url.searchParams.get("lxm"), "com.atproto.server.createAccount");

    const car = new Uint8Array([0x3a, 0xa2, 0x65]);
    await native.importRepo({ account, car });
    assert.equal(calls[1]?.url.pathname, "/xrpc/com.atproto.repo.importRepo");
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[1]?.headers.get("content-type"), "application/vnd.ipld.car");
    assert.equal(calls[1]?.raw, car);

    const missing = await native.listMissingBlobs({ account, limit: 500 });
    assert.equal(missing.blobs[0]?.cid, "bafkreimissing");
    assert.equal(calls[2]?.url.searchParams.get("limit"), "500");

    const credentials = await native.getRecommendedDidCredentials({ account });
    await native.requestPlcOperationSignature({ account });
    assert.equal(calls[4]?.method, "POST");

    const operation = await native.signPlcOperation({
      account,
      token: "IIIII-JJJJJ",
      rotationKeys: ["did:key:zNew"],
      services: { atproto_pds: { type: "AtprotoPersonalDataServer", endpoint: service } },
    });

    assert.deepEqual(calls[5]?.body?.["rotationKeys"], credentials["rotationKeys"]);

    await native.submitPlcOperation({ account, operation });
    assert.equal(calls[6]?.url.pathname, "/xrpc/com.atproto.identity.submitPlcOperation");
    assert.deepEqual(calls[6]?.body, { operation: { type: "plc_operation", sig: "fixture" } });

    await assert.rejects(native.getServiceAuth({ account, aud: "new-pds.example" }), invalid);
    await assert.rejects(native.importRepo({ account, car: new Uint8Array() }), invalid);
    assert.equal(calls.length, 7);
  });
});

describe("Bluesky contact import", () => {
  it("verifies a phone and matches contacts with app.bsky.contact.importContacts", async () => {
    const { native, calls } = harness(({ url }) => {
      if (url.pathname.endsWith("verifyPhone")) return json({ token: "fixture-phone-token" });

      if (url.pathname.endsWith("importContacts"))
        return json({
          matchesAndContactIndexes: [
            { match: { did: "did:plc:friend", handle: "friend.test" }, contactIndex: 1 },
          ],
        });

      if (url.pathname.endsWith("getMatches"))
        return json({ matches: [{ did: "did:plc:friend", handle: "friend.test" }] });

      if (url.pathname.endsWith("getSyncStatus"))
        return json({ syncStatus: { syncedAt: "2026-11-04T00:00:00.000Z", matchesCount: 1 } });

      return json({});
    });

    await native.startPhoneVerification({ account, phone: "+15555550100" });
    assert.deepEqual(calls[0]?.body, { phone: "+15555550100" });

    const { token } = await native.verifyPhone({ account, phone: "+15555550100", code: "123456" });

    const matches = await native.importContacts({
      account,
      token,
      contacts: ["+15555550101", "+15555550102"],
    });

    assert.deepEqual(matches, [
      { match: { did: "did:plc:friend", handle: "friend.test" }, contactIndex: 1 },
    ]);
    assert.equal(calls[2]?.url.pathname, "/xrpc/app.bsky.contact.importContacts");
    assert.deepEqual(calls[2]?.body, {
      token: "fixture-phone-token",
      contacts: ["+15555550101", "+15555550102"],
    });

    assert.equal((await native.getContactMatches({ account })).actors.length, 1);
    await native.dismissContactMatch({ account, subject: "did:plc:friend" });
    assert.deepEqual(calls[4]?.body, { subject: "did:plc:friend" });

    assert.deepEqual(await native.getContactSyncStatus({ account }), {
      syncedAt: "2026-11-04T00:00:00.000Z",
      matchesCount: 1,
    });

    await native.removeContactData({ account });
    assert.equal(calls[6]?.url.pathname, "/xrpc/app.bsky.contact.removeData");

    await assert.rejects(
      native.importContacts({ account, token, contacts: ["555-0101"] }),
      invalid,
    );
    assert.equal(calls.length, 7);
  });
});
