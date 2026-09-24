import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { SocialError } from "../src/core/errors.js";
import { linkedin } from "../src/platforms/linkedin.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const member = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:782bbtaQ",
});

const organization = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:organization:79988552",
});

it("LinkedIn member accounts read OpenID Connect userinfo without versioned headers or private fields", async () => {
  const requests: { url: string; headers: Headers }[] = [];

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
      apiVersion: "202609",
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });

        return Response.json({
          sub: "782bbtaQ",
          name: "John Doe",
          given_name: "John",
          family_name: "Doe",
          picture: "https://media.licdn-ei.com/private-picture",
          email: "doe@email.com",
          email_verified: true,
        });
      },
    }),
  });

  const page = await social.accounts.list();
  assert.deepEqual(page.items, [{ ref: member, displayName: "John Doe", status: "connected" }]);
  assert.equal(page.nextCursor, undefined);
  assert.ok(!JSON.stringify(page).includes("doe@email.com"));

  const record = await social.accounts.get(member);
  assert.deepEqual(record, { ref: member, displayName: "John Doe", status: "connected" });

  assert.equal(requests.length, 2);

  for (const request of requests) {
    assert.equal(request.url, "https://api.linkedin.com/v2/userinfo");
    assert.equal(request.headers.get("Authorization"), "Bearer secret");
    assert.equal(request.headers.get("Linkedin-Version"), null);
  }
});

it("LinkedIn member accounts fall back to given and family names", async () => {
  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () => Response.json({ sub: "782bbtaQ", given_name: "John", family_name: "Doe" }),
  });

  const record = await adapter.accounts!.get(member, nativeContext);
  assert.equal(record.displayName, "John Doe");
});

it("LinkedIn rejects a userinfo subject that differs from the configured author", async () => {
  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () => Response.json({ sub: "someoneElse", name: "Other" }),
  });

  await assert.rejects(
    adapter.accounts!.list({}, nativeContext),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );
  await assert.rejects(
    adapter.accounts!.list({}, nativeContext),
    /differs from the configured author URN/,
  );
});

it("LinkedIn reports missing openid/profile scopes as missing_permission", async () => {
  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () =>
      Response.json({ status: 403, message: "Not enough permissions" }, { status: 403 }),
  });

  await assert.rejects(adapter.accounts!.get(member, nativeContext), (error) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "missing_permission");
    assert.equal(error.operation, "accounts.read");
    assert.match(error.message, /openid and profile/);
    assert.equal(error.upstreamStatus, 403);
    assert.ok(!error.message.includes("secret"));

    return true;
  });
});

it("LinkedIn maps an expired userinfo token to reconnect_required", async () => {
  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () => new Response(null, { status: 401 }),
  });

  await assert.rejects(
    adapter.accounts!.list({}, nativeContext),
    (error) => error instanceof SocialError && error.code === "reconnect_required",
  );
});

it("LinkedIn organization accounts read the administered organization with versioned headers", async () => {
  const requests: { url: string; headers: Headers }[] = [];

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: "urn:li:organization:79988552" },
      apiVersion: "202609",
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });

        return Response.json({
          vanityName: "firstdemocompany",
          localizedName: "FirstDemoCompany",
          versionTag: "111146657",
          organizationType: "SELF_EMPLOYED",
          id: 79988552,
          $URN: "urn:li:organization:79988552",
        });
      },
    }),
  });

  const page = await social.accounts.list();
  assert.deepEqual(page.items, [
    {
      ref: organization,
      displayName: "FirstDemoCompany",
      handle: "firstdemocompany",
      status: "connected",
    },
  ]);
  assert.deepEqual(await social.accounts.get(organization), page.items[0]);

  assert.equal(requests.length, 2);

  for (const request of requests) {
    assert.equal(request.url, "https://api.linkedin.com/rest/organizations/79988552");
    assert.equal(request.headers.get("Linkedin-Version"), "202609");
    assert.equal(request.headers.get("X-Restli-Protocol-Version"), "2.0.0");
  }
});

it("LinkedIn organization accounts require administrator access and a matching organization", async () => {
  const denied = linkedin({
    auth: { accessToken: "secret", author: "urn:li:organization:79988552" },
    apiVersion: "202609",
    fetch: async () =>
      Response.json(
        {
          status: 403,
          message:
            "Viewer don't have permission to the ADMIN_ONLY VisibilityReduction for urn:li:organization:79988552",
        },
        { status: 403 },
      ),
  });

  await assert.rejects(denied.accounts!.list({}, nativeContext), (error) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "missing_permission");
    assert.match(error.message, /rw_organization_admin/);
    assert.match(error.message, /ADMINISTRATOR/);

    return true;
  });

  const mismatched = linkedin({
    auth: { accessToken: "secret", author: "urn:li:organization:79988552" },
    apiVersion: "202609",
    fetch: async () => Response.json({ id: 27056405, localizedName: "Other" }),
  });

  await assert.rejects(
    mismatched.accounts!.get(organization, nativeContext),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );
});

it("LinkedIn accounts.get rejects references for another author before any request", async () => {
  let calls = 0;

  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () => {
      calls++;

      return Response.json({ sub: "782bbtaQ", name: "John Doe" });
    },
  });

  await assert.rejects(
    adapter.accounts!.get({ ...member, accountId: "urn:li:person:other" }, nativeContext),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );
  assert.equal(calls, 0);
});

it("LinkedIn declares accounts.read scopes per author type", () => {
  const scopes = (author: `urn:li:person:${string}` | `urn:li:organization:${string}`) =>
    linkedin({
      auth: { accessToken: "secret", author },
      apiVersion: "202609",
    }).capabilities.capabilities.find((entry) => entry.operation === "accounts.read");

  const memberEntry = scopes("urn:li:person:782bbtaQ");
  assert.equal(memberEntry?.availability, "available");
  assert.deepEqual(memberEntry?.requiredScopes, ["openid", "profile"]);

  const organizationEntry = scopes("urn:li:organization:79988552");
  assert.equal(organizationEntry?.availability, "available");
  assert.deepEqual(organizationEntry?.requiredScopes, ["rw_organization_admin"]);
});

it("LinkedIn lists administered organizations from organizationAcls with offset pagination", async () => {
  const urls: URL[] = [];

  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);

      if (url.searchParams.get("start") === "0")
        return Response.json({
          elements: [
            {
              role: "ADMINISTRATOR",
              organization: "urn:li:organization:2414183",
              roleAssignee: "urn:li:person:782bbtaQ",
              state: "APPROVED",
            },
            {
              role: "ADMINISTRATOR",
              organizationTarget: "urn:li:organization:79988552",
              roleAssignee: "urn:li:person:782bbtaQ",
              state: "APPROVED",
            },
            {
              role: "ADMINISTRATOR",
              organization: "urn:li:organization:1234123",
              roleAssignee: "urn:li:person:782bbtaQ",
              state: "REVOKED",
            },
          ],
          paging: {
            start: 0,
            count: 3,
            links: [{ rel: "next", href: "/rest/organizationAcls?start=3" }],
          },
        });

      return Response.json({ elements: [], paging: { start: 3, count: 3, links: [] } });
    },
  });

  const first = await adapter.native!.listAdministeredOrganizations({
    account: member,
    limit: 3,
    context: nativeContext,
  });

  assert.deepEqual(first.items, [
    { organization: "urn:li:organization:2414183", role: "ADMINISTRATOR", state: "APPROVED" },
    { organization: "urn:li:organization:79988552", role: "ADMINISTRATOR", state: "APPROVED" },
  ]);
  assert.equal(first.nextCursor, "3");

  const second = await adapter.native!.listAdministeredOrganizations({
    account: member,
    cursor: first.nextCursor!,
    limit: 3,
    context: nativeContext,
  });

  assert.deepEqual(second.items, []);
  assert.equal(second.nextCursor, undefined);

  assert.equal(urls[0]?.pathname, "/rest/organizationAcls");
  assert.equal(urls[0]?.searchParams.get("q"), "roleAssignee");
  assert.equal(urls[0]?.searchParams.get("roleAssignee"), "urn:li:person:782bbtaQ");
  assert.equal(urls[0]?.searchParams.get("role"), "ADMINISTRATOR");
  assert.equal(urls[0]?.searchParams.get("state"), "APPROVED");
  assert.equal(urls[0]?.searchParams.get("count"), "3");
  assert.equal(urls[1]?.searchParams.get("start"), "3");
});

it("LinkedIn administered organization lookup validates input and reports missing scopes", async () => {
  let calls = 0;

  const adapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:782bbtaQ" },
    apiVersion: "202609",
    fetch: async () => {
      calls++;

      return new Response(null, { status: 403 });
    },
  });

  for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: "" }, { cursor: "-1" }])
    await assert.rejects(
      adapter.native!.listAdministeredOrganizations({
        account: member,
        ...input,
        context: nativeContext,
      }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
  assert.equal(calls, 0);

  await assert.rejects(
    adapter.native!.listAdministeredOrganizations({ account: member, context: nativeContext }),
    (error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "missing_permission");
      assert.match(error.message, /rw_organization_admin or r_organization_admin/);

      return true;
    },
  );

  await assert.rejects(
    adapter.native!.listAdministeredOrganizations({
      account: { ...member, accountId: "urn:li:person:other" },
      context: nativeContext,
    }),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );

  const organizationAdapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:organization:79988552" },
    apiVersion: "202609",
    fetch: async () => Response.json({ elements: [] }),
  });

  await assert.rejects(
    organizationAdapter.native!.listAdministeredOrganizations({
      account: organization,
      context: nativeContext,
    }),
    (error) => error instanceof SocialError && error.code === "unauthorized",
  );
});
