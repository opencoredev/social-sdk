---
"@opencoredev/social-sdk": minor
---

Add `accounts.list` and `accounts.get` to the direct LinkedIn adapter. A member author reads the OpenID Connect `userinfo` endpoint (`openid` and `profile` scopes) and must match `urn:li:person:{sub}`. An organization author reads `/rest/organizations/{id}`, which needs `rw_organization_admin` and an approved `ADMINISTRATOR` role. A `403` reports `missing_permission` with the required scopes, and a mismatched identity reports `unauthorized`. The native module adds `listAdministeredOrganizations`, which pages through the member's approved administrator roles from `organizationAcls`.
