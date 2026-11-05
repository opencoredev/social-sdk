import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const memberUrn = "urn:li:person:member1";

const organizationUrn = "urn:li:organization:2414183";

const member = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: memberUrn,
});

const organization = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: organizationUrn,
});

function setup(author: "member" | "organization", respond: (url: string) => Response) {
  const urls: string[] = [];

  const adapter = linkedin({
    auth: { accessToken: "secret", author: author === "member" ? memberUrn : organizationUrn },
    apiVersion: "202610",
    fetch: async (input) => {
      urls.push(String(input));

      return respond(String(input));
    },
  });

  return { urls, adapter, native: adapter.native! };
}

it("looks up organizations with organizationsLookup and q=vanityName", async () => {
  const { urls, native } = setup("member", (url) =>
    url.includes("organizationsLookup")
      ? Response.json({
          results: {
            "90966477": {
              id: 90966477,
              vanityName: "devtestcocompany",
              localizedName: "Devtestco",
              localizedWebsite: "LinkedIn.com",
              primaryOrganizationType: "NONE",
            },
          },
          statuses: { "90966477": 200, "79988552": 404 },
          errors: {},
        })
      : Response.json({
          elements: [
            {
              id: 11832,
              vanityName: "boisestate",
              localizedName: "Boise State University",
              primaryOrganizationType: "SCHOOL",
            },
          ],
        }),
  );

  const lookup = await native.lookupOrganizations({
    account: member,
    organizations: ["urn:li:organization:90966477", "urn:li:organization:79988552"],
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/organizationsLookup?ids=List(90966477,79988552)",
  );
  assert.deepEqual(lookup, {
    organizations: [
      {
        organization: "urn:li:organization:90966477",
        localizedName: "Devtestco",
        vanityName: "devtestcocompany",
        localizedWebsite: "LinkedIn.com",
        primaryOrganizationType: "NONE",
      },
    ],
    errors: [{ organization: "urn:li:organization:79988552", status: 404 }],
  });

  const schools = await native.findOrganizationByVanityName({
    account: member,
    vanityName: "boisestate",
    context: nativeContext,
  });

  assert.equal(
    urls[1],
    "https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=boisestate",
  );
  assert.equal(schools[0]?.organization, "urn:li:organization:11832");
  assert.equal(schools[0]?.primaryOrganizationType, "SCHOOL");
});

it("discovers showcase pages with the q=parentOrganization finder", async () => {
  const { urls, native } = setup("member", () =>
    Response.json({
      paging: { start: 0, count: 1, links: [], total: 2 },
      elements: [
        {
          id: 89758488,
          vanityName: "internal-ei-demo",
          localizedName: "Internal_EI_Demo",
          primaryOrganizationType: "BRAND",
        },
      ],
    }),
  );

  const brands = await native.listOrganizationBrands({
    account: member,
    parent: "urn:li:organization:79988552",
    limit: 1,
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/organizations?q=parentOrganization&parent=urn%3Ali%3Aorganization%3A79988552&start=0&count=1",
  );
  assert.equal(brands.items[0]?.primaryOrganizationType, "BRAND");
  assert.equal(brands.nextCursor, "1");
});

it("lists a member's organizations for any role [feature:linkedin.account.administered_orgs]", async () => {
  const { urls, native } = setup("member", () =>
    Response.json({
      elements: [
        {
          role: "CONTENT_ADMINISTRATOR",
          organization: "urn:li:organization:1234123",
          roleAssignee: memberUrn,
          state: "APPROVED",
        },
        {
          role: "ADMINISTRATOR",
          organization: "urn:li:organization:999",
          roleAssignee: memberUrn,
          state: "APPROVED",
        },
      ],
      paging: { count: 10, start: 0, links: [] },
    }),
  );

  const page = await native.listAdministeredOrganizations({
    account: member,
    role: "CONTENT_ADMINISTRATOR",
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&roleAssignee=urn%3Ali%3Aperson%3Amember1&role=CONTENT_ADMINISTRATOR&state=APPROVED&start=0&count=25",
  );
  assert.deepEqual(page.items, [
    {
      organization: "urn:li:organization:1234123",
      role: "CONTENT_ADMINISTRATOR",
      state: "APPROVED",
    },
  ]);
});

it("lists the organization's role holders with organizationAcls?q=organization", async () => {
  const { urls, native } = setup("organization", () =>
    Response.json({
      elements: [
        {
          state: "APPROVED",
          role: "ADMINISTRATOR",
          roleAssignee: "urn:li:person:A839rocZ",
          organizationTarget: organizationUrn,
        },
      ],
      paging: { count: 10, start: 0 },
    }),
  );

  const page = await native.listOrganizationRoles({
    account: organization,
    role: "ADMINISTRATOR",
    state: "APPROVED",
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/organizationAcls?q=organization&organization=urn%3Ali%3Aorganization%3A2414183&role=ADMINISTRATOR&state=APPROVED&start=0&count=25",
  );
  assert.deepEqual(page.items, [
    {
      organization: organizationUrn,
      roleAssignee: "urn:li:person:A839rocZ",
      role: "ADMINISTRATOR",
      state: "APPROVED",
    },
  ]);

  const foreign = setup("organization", () =>
    Response.json({
      elements: [
        {
          state: "APPROVED",
          role: "ADMINISTRATOR",
          roleAssignee: "urn:li:person:x",
          organization: "urn:li:organization:1",
        },
      ],
    }),
  );

  await assert.rejects(
    foreign.native.listOrganizationRoles({ account: organization, context: nativeContext }),
    /another organization/,
  );
});

it("reads per-post organization statistics with shares=List(...) and ugcPosts=List(...)", async () => {
  const { urls, native } = setup("organization", () =>
    Response.json({
      elements: [
        {
          organizationalEntity: organizationUrn,
          share: "urn:li:share:1000000",
          totalShareStatistics: {
            clickCount: 78,
            commentCount: 24,
            engagement: 0.022886324947985624,
            impressionCount: 5287,
            uniqueImpressionsCount: 4100,
            likeCount: 14,
            shareCount: 5,
          },
        },
      ],
      paging: { count: 10, links: [], start: 0 },
    }),
  );

  const stats = await native.getOrganizationPostStatistics({
    account: organization,
    postIds: ["urn:li:share:1000000", "urn:li:ugcPost:1000001"],
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183&shares=List(urn%3Ali%3Ashare%3A1000000)&ugcPosts=List(urn%3Ali%3AugcPost%3A1000001)",
  );
  assert.deepEqual(stats, [
    {
      post: "urn:li:share:1000000",
      metrics: {
        clickCount: 78,
        commentCount: 24,
        engagement: 0.022886324947985624,
        impressionCount: 5287,
        uniqueImpressionsCount: 4100,
        likeCount: 14,
        shareCount: 5,
      },
    },
  ]);
});

it("reads brandPageStatistics for the configured organization as a showcase page", async () => {
  const { urls, native } = setup("organization", () =>
    Response.json({
      elements: [
        {
          brand: "urn:li:organizationBrand:2414183",
          timeRange: { start: 1551398400000, end: 1551484800000 },
          totalPageStatistics: { views: { allPageViews: { pageViews: 1 } } },
        },
      ],
    }),
  );

  const stats = await native.getBrandPageStatistics({
    account: organization,
    interval: { granularity: "DAY", start: 1551398400000, end: 1552003200000 },
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/brandPageStatistics?q=brand&brand=urn%3Ali%3AorganizationBrand%3A2414183&timeIntervals=(timeRange:(start:1551398400000,end:1552003200000),timeGranularityType:DAY)",
  );
  assert.equal(stats[0]?.organization, "urn:li:organizationBrand:2414183");
  assert.deepEqual(stats[0]?.views, { allPageViews: 1 });
});

it("reads memberCreatorPostAnalytics for one post and for all posts", async () => {
  const { urls, native } = setup("member", () =>
    Response.json({
      elements: [
        {
          count: 10,
          metricType: "REACTION",
          targetEntity: { share: "urn:li:share:7325786486870552578" },
          dateRange: {
            start: { month: 5, day: 4, year: 2024 },
            end: { month: 5, day: 5, year: 2024 },
          },
        },
        {
          count: 20,
          metricType: {
            "com.linkedin.adsexternalapi.memberanalytics.v1.CreatorPostAnalyticsMetricTypeV1":
              "REACTION",
          },
          targetEntity: { share: "urn:li:share:7325786486870552578" },
        },
      ],
      paging: { count: 10, start: 0, links: [] },
    }),
  );

  const points = await native.getMemberPostAnalytics({
    account: member,
    postId: "urn:li:share:7325786486870552578",
    metric: "REACTION",
    aggregation: "DAILY",
    dateRange: { start: { year: 2024, month: 5, day: 4 }, end: { year: 2024, month: 5, day: 6 } },
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=(share:urn%3Ali%3Ashare%3A7325786486870552578)&queryType=REACTION&aggregation=DAILY&dateRange=(start:(year:2024,month:5,day:4),end:(year:2024,month:5,day:6))",
  );
  assert.deepEqual(points, [
    {
      metric: "REACTION",
      count: 10,
      post: "urn:li:share:7325786486870552578",
      dateRange: { start: { year: 2024, month: 5, day: 4 }, end: { year: 2024, month: 5, day: 5 } },
    },
    { metric: "REACTION", count: 20, post: "urn:li:share:7325786486870552578" },
  ]);

  await native.getMemberPostAnalytics({
    account: member,
    metric: "IMPRESSION",
    context: nativeContext,
  });

  assert.equal(
    urls[1],
    "https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=me&queryType=IMPRESSION&aggregation=TOTAL",
  );

  await assert.rejects(
    native.getMemberPostAnalytics({
      account: member,
      metric: "MEMBERS_REACHED",
      aggregation: "DAILY",
      context: nativeContext,
    }),
    /DAILY is not supported/,
  );

  const old = linkedin({
    auth: { accessToken: "secret", author: memberUrn },
    apiVersion: "202603",
  }).native!;

  await assert.rejects(
    old.getMemberPostAnalytics({ account: member, metric: "POST_SAVE", context: nativeContext }),
    /202604/,
  );
  assert.equal(urls.length, 2);
});

it("reads memberCreatorVideoAnalytics and rejects unsupported video metric combinations", async () => {
  const { urls, native } = setup("member", () =>
    Response.json({
      elements: [
        {
          count: 7852,
          metricType: "VIDEO_PLAY",
          targetEntity: { ugc: "urn:li:ugcPost:7325786486870552578" },
        },
      ],
    }),
  );

  const points = await native.getMemberVideoAnalytics({
    account: member,
    postId: "urn:li:ugcPost:7325786486870552578",
    metric: "VIDEO_PLAY",
    context: nativeContext,
  });

  assert.equal(
    urls[0],
    "https://api.linkedin.com/rest/memberCreatorVideoAnalytics?q=entity&entity=(ugc:urn%3Ali%3AugcPost%3A7325786486870552578)&queryType=VIDEO_PLAY&aggregation=TOTAL",
  );
  assert.deepEqual(points, [
    { metric: "VIDEO_PLAY", count: 7852, post: "urn:li:ugcPost:7325786486870552578" },
  ]);
  await assert.rejects(
    native.getMemberVideoAnalytics({
      account: member,
      postId: "urn:li:ugcPost:1",
      metric: "VIDEO_WATCH_TIME",
      aggregation: "DAILY",
      context: nativeContext,
    }),
    /only VIDEO_PLAY/,
  );

  const organizationNative = setup("organization", () => Response.json({})).native;

  await assert.rejects(
    organizationNative.getMemberVideoAnalytics({
      account: organization,
      postId: "urn:li:ugcPost:1",
      metric: "VIDEO_PLAY",
      context: nativeContext,
    }),
    /member account/,
  );
});

it("reads memberFollowersCount for member account metrics and daily follower counts", async () => {
  const { urls, adapter, native } = setup("member", (url) =>
    url.includes("q=me")
      ? Response.json({ elements: [{ memberFollowersCount: 100 }], paging: { total: 1 } })
      : Response.json({
          elements: [
            {
              memberFollowersCount: 2,
              dateRange: {
                start: { month: 5, year: 2024, day: 4 },
                end: { month: 5, year: 2024, day: 5 },
              },
            },
          ],
        }),
  );

  const metrics = await adapter.analytics!.getAccountMetrics!(member, nativeContext);

  assert.equal(urls[0], "https://api.linkedin.com/rest/memberFollowersCount?q=me");
  assert.equal(metrics[0]?.name, "followers");
  assert.equal(metrics[0]?.value, 100);

  const daily = await native.getMemberFollowerCount({
    account: member,
    dateRange: { start: { year: 2024, month: 5, day: 4 }, end: { year: 2024, month: 5, day: 6 } },
    context: nativeContext,
  });

  assert.equal(
    urls[1],
    "https://api.linkedin.com/rest/memberFollowersCount?q=dateRange&dateRange=(start:(year:2024,month:5,day:4),end:(year:2024,month:5,day:6))",
  );
  assert.deepEqual(daily, [
    {
      count: 2,
      dateRange: { start: { year: 2024, month: 5, day: 4 }, end: { year: 2024, month: 5, day: 5 } },
    },
  ]);

  const scopes = (operation: string) =>
    adapter.capabilities.capabilities.find((entry) => entry.operation === operation)
      ?.requiredScopes;

  assert.deepEqual(scopes("analytics.member.posts.read"), ["r_member_postAnalytics"]);
  assert.deepEqual(scopes("analytics.member.followers.read"), ["r_member_profileAnalytics"]);
  assert.deepEqual(scopes("analytics.account.read"), ["r_member_profileAnalytics"]);
});
