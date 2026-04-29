---
name: App Store Connect
description: Activate when the user asks about App Store Connect, Apple APIs, app reviews, sales or financial reports, TestFlight, beta testers, beta groups, in-app purchases, subscriptions, app metadata, or any iOS/macOS app management task involving the App Store Connect API.
---

## Tools Available

Two MCP tools expose the full App Store Connect API (923 endpoints, spec v4.3):

- **`mcp__appstore-connect__search`** — Explore the OpenAPI spec. Use this first to find endpoint paths, required parameters, and response shapes.
- **`mcp__appstore-connect__execute`** — Run authenticated JavaScript against the live API. The `api` global provides an authenticated HTTP client; JWT is injected automatically.
- **`mcp__appstore-connect__test_connection`** — Verify credentials and server health.

## Required Environment Variables

Users must have these set before the server starts:

| Variable | Description |
|---|---|
| `APP_STORE_KEY_ID` | 10-character key ID from App Store Connect → Users and Access → Keys |
| `APP_STORE_ISSUER_ID` | UUID from the same page |
| `APP_STORE_P8_PATH` | Absolute path to the `.p8` private key file |
| `APP_STORE_VENDOR_NUMBER` | Required for sales/financial reports (Payments section) |

## Workflow: Search Then Execute

Always search first when the endpoint path is unknown:

```javascript
// search: find review endpoints
const results = Object.entries(spec.paths)
  .filter(([p]) => p.includes('customerReview'))
  .map(([path, methods]) => ({ path, methods: Object.keys(methods) }));
return results;
```

Then execute against the live API:

```javascript
// execute: list apps
const apps = await api.request({ method: 'GET', path: '/v1/apps', params: { limit: '10' } });
return apps.data.map(a => ({ id: a.id, name: a.attributes.name }));
```

## Common Patterns

### List apps
```javascript
const apps = await api.request({ method: 'GET', path: '/v1/apps', params: { limit: '200' } });
return apps.data.map(a => ({ id: a.id, name: a.attributes.name, bundleId: a.attributes.bundleId }));
```

### Customer reviews
```javascript
const reviews = await api.request({
  method: 'GET',
  path: `/v1/apps/${appId}/customerReviews`,
  params: { limit: '50', sort: '-createdDate' }
});
return reviews.data.map(r => r.attributes);
```

### Sales report (returns gzip-decompressed CSV)
```javascript
const report = await api.request({
  method: 'GET',
  path: '/v1/salesReports',
  params: {
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[frequency]': 'DAILY',
    'filter[reportDate]': '2025-04-27',
    'filter[vendorNumber]': process.env.APP_STORE_VENDOR_NUMBER,
    'filter[version]': '1_1'
  }
});
return report; // decoded CSV string
```

### TestFlight beta testers
```javascript
const testers = await api.request({
  method: 'GET',
  path: '/v1/betaTesters',
  params: { limit: '100' }
});
return testers.data.map(t => t.attributes);
```

### Multi-step: get app then its builds
```javascript
const apps = await api.request({ method: 'GET', path: '/v1/apps', params: { limit: '5' } });
const appId = apps.data[0].id;
const builds = await api.request({
  method: 'GET',
  path: `/v1/apps/${appId}/builds`,
  params: { limit: '10', sort: '-uploadedDate' }
});
return { app: apps.data[0].attributes.name, builds: builds.data.map(b => b.attributes) };
```

## Report Version Requirements

| Report Type | Required Version |
|---|---|
| Sales | `1_1` |
| Subscriptions | `1_3` |
| Financial | `1_0` |

Apple's error response states the correct version if you provide the wrong one.

## Error Handling

Wrap multi-step calls in try/catch. Common errors:

- **401**: Invalid or expired credentials — check env vars and P8 key format (must include `-----BEGIN PRIVATE KEY-----` headers)
- **403**: API key lacks permission for this endpoint — check scopes in App Store Connect
- **429**: Rate limited — built-in exponential backoff handles this; reduce frequency if it persists
- **No data**: Verify the app ID exists and the date range has data
