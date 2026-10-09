# Reap MCP

A TypeScript Model Context Protocol (MCP) server for approval-gated commerce. An assistant can search products, prepare a quote, connect a payment method, request a checkout, and check its outcome. The user completes card entry and purchase approval in a browser; the assistant never receives card details or authorizes payment.

**Start with mock mode.** It provides a small simulated catalog, card enrollment, approval pages, and failure scenarios without calling Reap or placing merchant orders. PostgreSQL still stores purchases and operation history so retries and recovery exercise the same application logic as the sandbox adapter.

Reap sandbox support is retained as an optional integration. It is not needed for local mock development or the default test suite. Production Reap hosts are not supported.

## Contents

- [Quick start: local mocks](#quick-start-local-mocks)
- [Connect an MCP client](#connect-an-mcp-client)
- [Mock purchase walkthrough](#mock-purchase-walkthrough)
- [MCP tool reference](#mcp-tool-reference)
- [Mock catalog and scenarios](#mock-catalog-and-scenarios)
- [Configuration reference](#configuration-reference)
- [Architecture and code map](#architecture-and-code-map)
- [State, idempotency, and recovery](#state-idempotency-and-recovery)
- [Storage and security boundaries](#storage-and-security-boundaries)
- [Authenticated HTTP transport](#authenticated-http-transport)
- [Optional Reap sandbox integration](#optional-reap-sandbox-integration)
- [Development and testing](#development-and-testing)
- [Deployment and operations](#deployment-and-operations)
- [Troubleshooting](#troubleshooting)
- [Current limitations](#current-limitations)

## Quick start: local mocks

### Requirements

- Node.js **22.16 or newer within the 22.x line**, or **24.x**, and npm. Other major versions are outside the declared support range.
- Docker with Compose v2 for the bundled PostgreSQL 17 service, or a separately provisioned PostgreSQL database.
- An MCP client with stdio support to use the tools interactively.

No Reap API key, OAuth provider, public callback URL, or tunnel is needed for the default loopback mock setup. Unit and contract tests also run without PostgreSQL:

```sh
npm ci
npm run check
```

### Set up the local application

Run these commands from the repository root. `setup:local` generates a database password and a 32-byte encryption key in a private `.env`, without printing them.

```sh
npm run setup:local
```

**If `.env` already exists, the setup script leaves it unchanged.** Before proceeding, confirm that it points to the intended local database and uses mock settings. An existing sandbox configuration is not converted automatically. Keep the encryption key for any database containing existing encrypted records; replacing the key makes those records unreadable.

The generated configuration uses:

| Setting | Local default |
| --- | --- |
| Provider | `APP_MODE=mock` |
| Browser pages | `http://127.0.0.1:3000` |
| Listener | `BIND_HOST=127.0.0.1`, `PORT=3000` |
| PostgreSQL | Host port `55432`, database `reap_mcp`, user `reap` |
| Catalog | `mock-coffee` / `Mock Coffee Roasters` |
| Region and currency | `US` / `USD` |
| Purchase cap | `100.00 USD` |
| Sandbox flags | `REAP_CHECKOUT_ENABLED=false`, `SANDBOX_SIMULATE_CHECKOUT=false` |

Once the local settings are confirmed:

```sh
docker compose up -d --wait db
npm run db:migrate
npm run build
```

The Compose file starts **only PostgreSQL**, not the MCP application. Its named volume persists database data. If using your own database, skip the Compose command and configure `DATABASE_URL` before migrating.

Next, configure your MCP client to launch the stdio entry point as described below. Do not start a second application process on the same callback port.

## Connect an MCP client

### Recommended: stdio

For clients using an `mcpServers` configuration object, this is a representative registration. Replace the absolute path; clients with different configuration formats need the equivalent command, arguments, and environment settings.

```json
{
  "mcpServers": {
    "reap-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/reap-mcp/dist/stdio-main.js"],
      "env": {
        "APP_MODE": "mock",
        "REAP_CHECKOUT_ENABLED": "false",
        "SANDBOX_SIMULATE_CHECKOUT": "false"
      }
    }
  }
}
```

This example assumes the local `.env` from the quick start. The provider overrides are a guard against accidentally selecting sandbox mode; they do not replace the database, callback, or merchant configuration. Keep API keys, the database password, and the encryption key in private environment configuration, not in a shared MCP registration.

The stdio process:

1. Loads the repository-relative `.env`, regardless of the client's working directory. Existing process environment variables take precedence.
2. Connects to the migrated database and starts recovery of eligible saved operations.
3. Serves browser callback pages and, in mock mode, simulated consent pages on `PORT`.
4. Exposes the five MCP tools over stdin/stdout. Logs go to stderr.

Its HTTP `/mcp` route is intentionally disabled. Use the tool connection, not the browser home page, to issue commerce requests.

For source-based development, configure the client to run `npm --silent run dev:stdio` in the repository directory. The silent flag keeps npm's lifecycle banner off the MCP protocol stream. The command is an MCP process, not an interactive shopping CLI; waiting for protocol input is normal. The `dev` scripts do not run a file watcher.

After changing source, rebuild and reconnect clients using `dist/stdio-main.js`. If a desktop client cannot locate Node, use the absolute executable path reported by `command -v node`.

### Ports and multiple clients

Each MCP subprocess also owns a browser callback listener. For concurrent clients, assign each process a different `PORT` and a matching `PUBLIC_BASE_URL`, for example port `3001` and `http://127.0.0.1:3001`. Use the configured hostname consistently: `localhost` and `127.0.0.1` are not interchangeable under the Host and Origin checks.

`npm run dev` and `npm start` launch the **authenticated HTTP transport**, not the local stdio workflow. They require OAuth configuration even when `APP_MODE=mock`; see [Authenticated HTTP transport](#authenticated-http-transport).

## Mock purchase walkthrough

Use the following tool calls through your MCP client with the default `US` / `USD` configuration and `MOCK_SCENARIO=success`.

Strings such as `<product_id>` are placeholders for IDs actually returned by your server. They are not valid inputs until replaced. These IDs are scoped to the authenticated identity and provider namespace; do not use provider fixture IDs such as `mock-beans` as MCP product IDs.

### 1. Search

Call `search_products`:

```json
{
  "query": "coffee",
  "country": "US",
  "currency": "USD",
  "limit": 5
}
```

Choose the returned **Mock Coffee Beans** product and retain its `product_id`. Search prices are indicative; they are not a final authorization amount.

### 2. Connect a simulated card

Call `connect_payment_method`:

```json
{}
```

The result includes `payment_method_id`, `enrollment_status: "REQUIRES_ACTION"`, and a `setup_url`. Open that link yourself and select **Connect a simulated card**. No card number or CVV is requested.

Then recheck the same method:

```json
{
  "payment_method_id": "<payment_method_id>"
}
```

Continue when the provider read confirms `ACTIVE`. A returned URL, a callback, or a masked label alone is not proof of an active enrollment.

### 3. Prepare a quote

Call `prepare_purchase` with a new key for this logical draft:

```json
{
  "action": "create",
  "product_id": "<product_id>",
  "quantity": 1,
  "option_ids": ["whole"],
  "country": "US",
  "currency": "USD",
  "shipping_address": {
    "recipient_name": "Demo Shopper",
    "line1": "1 Demo Street",
    "city": "Example City",
    "postal_code": "10001",
    "country": "US"
  },
  "max_total": "30.00",
  "operation_key": "demo-coffee-001"
}
```

The address is fictional mock data. For an actual user-directed sandbox flow, ask the user for their information; do not reuse these example details.

The default quote is `18.50 USD` for the item plus `4.00 USD` standard shipping, for a final total of `22.50 USD`. The displayed `1.00 USD` tax is marked **included in prices**; do not add it again. Retain the returned `purchase_id` and `revision`, and show the full breakdown to the user.

Missing options or address fields return `NEEDS_INPUT` with `required_fields`; ask for them and submit the completed input. Once a draft exists, reuse its `operation_key` only with the same preparation input. A genuinely new purchase needs a new key, but a timeout does not justify rotating keys.

### 4. Optionally select shipping

Call `prepare_purchase` again, this time with `action: "select_shipping"`:

```json
{
  "action": "select_shipping",
  "purchase_id": "<purchase_id>",
  "expected_revision": 1,
  "shipping_option_id": "express"
}
```

Use the actual current revision, not an assumed value. In this fresh example, express shipping changes the total to `27.50 USD` and the revision to `2`. Review the updated terms. Shipping cannot change after checkout has started.

### 5. Request checkout, then approve in the browser

After the user chooses to proceed, call `request_purchase`:

```json
{
  "purchase_id": "<purchase_id>",
  "expected_revision": 2,
  "payment_method_id": "<payment_method_id>"
}
```

This example assumes the express-shipping step was completed. If skipped, use the revision returned by preparation instead.

The result should be `REQUIRES_ACTION` with an `approval_url`. Open it yourself, review the simulated quote, and approve or decline. A chat message does not replace this browser approval. No real payment or merchant order is created in mock mode.

### 6. Read the outcome

Call `get_purchase_status`:

```json
{
  "purchase_id": "<purchase_id>"
}
```

The mock advances through `PROCESSING` to `COMPLETED` as the existing checkout is read; callback visits also count as reads. Completion normally includes `charged_amount` and an order reference prefixed with `MOCK-`.

Always inspect `reconciliation_required`, warnings, and `next_action`, even when the provider reports completion. Do not create a replacement checkout to investigate an uncertain outcome.

## MCP tool reference

The exact input and output contracts are defined in [src/schemas.ts](src/schemas.ts); `tools/list` publishes their JSON schemas. All input objects reject unknown properties. There is no model-supplied owner ID, card data, approval flag, arbitrary URL, or provider credential field.

| Tool | Required scope | Inputs and behavior |
| --- | --- | --- |
| `connect_payment_method` | `payment-methods:write` | Optional `payment_method_id` to recheck an owned enrollment. Without it, reuse the current enrollment or create one if none is current. Requires a verified identity email for creation. |
| `search_products` | `commerce:read` | Required `query`, `country`, `currency`; optional `max_item_price`, `merchant_preference`, `limit` (1–10, default 5), and `cursor`. Returns local product IDs, indicative prices, warnings, and a local next-page cursor. |
| `prepare_purchase` — `create` | `commerce:prepare` | Required `action`, `product_id`, `quantity` (1–10), `country`, `currency`, and `operation_key`. Optional `option_ids`, `contact_email`, `shipping_address`, `max_total`, and `offer_code`. Resolves details/availability and creates a quote, not a checkout. |
| `prepare_purchase` — `select_shipping` | `commerce:prepare` | Required `action`, `purchase_id`, `expected_revision` (integer ≥1), and `shipping_option_id`. Updates a ready draft and increments its revision. |
| `request_purchase` | `commerce:checkout` | Required `purchase_id`, `expected_revision`, and `payment_method_id`. Rechecks ownership, enrollment, quote, revision, budget, and provider gates before creating at most one checkout for the draft. |
| `get_purchase_status` | `commerce:read` | Required `purchase_id`. Reads saved state and, when available, the existing provider checkout. Does not create, reprice, or replay a checkout. |

### Input details

- **Money:** supply non-negative decimal strings such as `"30.00"`, not JSON numbers or exponent notation. Precision must match the currency. `max_item_price` filters search item prices; `max_total` constrains the final purchase total, including shipping and adjustments. The configured server cap is enforced separately.
- **Region:** use configured uppercase country/currency codes. Preparation must use the same country and currency as the selected search result.
- **Merchants:** by default, `merchant_preference` is a key in `ALLOWED_MERCHANTS`. With explicit `ALLOW_ALL_MERCHANTS=true`, returned merchant names become the keys/preferences. Other safety limits remain in force.
- **Options:** use exact `option_ids` supplied in a `NEEDS_INPUT` response, with one selection per option group. Unavailable options are rejected rather than substituted. Product details and variant resolution happen inside preparation; they are not extra MCP tools.
- **Delivery:** address fields are `recipient_name`, `first_name`, `last_name`, `line1`, `line2`, `city`, `region`, `postal_code`, `country`, and `phone`. Shipped products require recipient name, line 1, city, postal code, and country. Sandbox additionally requires explicit first/last names and an international-format phone number; merchants can require more fields.
- **Email:** `contact_email` overrides the order contact email, otherwise a verified profile email is used. It does not override enrollment ownership or verify an identity's email.
- **Keys and cursors:** `operation_key` contains 1–128 letters, digits, underscores, or hyphens. Product/payment/purchase/cursor IDs are opaque local UUIDs. Cursors expire after 30 minutes and bind to the same user, namespace, and complete search criteria, including the page size. Product handles expire after 24 hours unless refreshed by search.

### Result envelope

Every tool returns:

| Field | Meaning |
| --- | --- |
| `ok` | Whether the tool call produced a successful application result. `NEEDS_INPUT` can be a successful result that still requires user input. |
| `mode` / `simulated` | Provider mode (`mock` or `sandbox`) and whether the result represents simulation. Sandbox checkout simulation is distinct from local mocks. |
| `status` | The current state or action/error code. A response such as `REVIEW_REQUIRED` is not itself a persisted purchase state. |
| `data` | Tool-specific product, enrollment, purchase, or missing-input details; sometimes saved purchase context on an error. |
| `next_action` | What the user/client should do next, optionally including a URL or polling delay; otherwise `null`. |
| `error` | Present on failures: `code`, safe `message`, `retryable`, and a `trace_id` for diagnostics. |

MCP responses contain both `structuredContent` and a full JSON text content block, plus a short human-readable summary. Text-only clients therefore still receive IDs, revisions, prices, and warnings. MCP `isError` corresponds to `!ok`.

Quote data includes every shipping option and an item/shipping/tax/discount/additional-charge breakdown. Unknown shipping or tax is `null`, **not zero**. Purchase data also includes budget evaluation, approval-link expiry, the last checked time, provider status, charged amount, order reference, and reconciliation warnings. Full delivery/contact data is not returned in the purchase view.

## Mock catalog and scenarios

The default fixture catalog is intentionally small:

| Product | USD item price | Options |
| --- | --- | --- |
| Mock Coffee Beans | `18.50` | `whole` — Whole beans; `ground` — Ground coffee; `sold-out` — unavailable Espresso grind |
| Mock Ceramic Coffee Mug | `12.00` | No selection required |

Both products require shipping. Standard shipping is `4.00`, express is `9.00`, and `SAVE10` applies a 10% item-subtotal discount. Search supports case-insensitive name matching, merchant selection, price filtering before pagination, and cursors. Prices are fixtures, not currency conversion or live merchant data; use the default USD configuration for the documented walkthrough.

Set `MOCK_SCENARIO` before starting/reconnecting a mock process:

| Scenario | Behavior |
| --- | --- |
| `success` | Browser-approved enrollment and checkout progress normally. |
| `decline` | A checkout fails even when the mock approve button is selected. Enrollment can still succeed. |
| `expired_quote` | Newly prepared quotes are already expired; checkout is blocked. |
| `changed_price` | A newly created quote's first refresh increases the total by one currency unit, producing `REVIEW_REQUIRED` and a new revision instead of submitting checkout. To trigger this case, request the initial quote without first replacing it through a shipping update. |
| `rate_limit` | The first search for a particular request in the mock namespace returns `UPSTREAM_RATE_LIMITED`; repeating it succeeds. The fault marker is durable, so restarting does not reset it. |
| `lost_response` | The mock accepts a checkout and then loses its response. Safe retries/recovery reuse the original idempotency key and stored result. |
| `unknown_status` | After approval/read progression, the provider returns an unrecognized status; the purchase requires reconciliation. |
| `missing_receipt` | The provider reports completion without an order reference or charged amount; the result retains reconciliation warnings. |

For example, with the local mock configuration already in place:

```sh
MOCK_SCENARIO=changed_price npm --silent run dev:stdio
```

Changing the scenario affects newly constructed mock requests, not the immutable requests already saved for recovery. Start a genuinely new draft when exploring a new scenario. Mock approval/setup links and normal mock quotes last 15 minutes; callback references last 24 hours.

## Configuration reference

[.env.example](.env.example) is the template; [src/config.ts](src/config.ts) validates the application configuration. Entrypoints load the repository-relative `.env` without overriding variables supplied by the shell or MCP client. Configuration errors identify fields but do not log their values.

Boolean values must be the strings `true` or `false`. Lists are comma-separated. JSON maps must remain valid JSON. `.env.example` contains placeholders, not usable credentials; use `setup:local` for a fresh mock environment.

### Runtime, database, and catalog

| Variable | Default / requirement | Purpose |
| --- | --- | --- |
| `APP_MODE` | `mock` | Select `mock` or `sandbox`. |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:3000` | Origin for callbacks and browser checks; no path, query, fragment, or credentials. HTTPS is required except for loopback-bound mock mode. |
| `BIND_HOST` | `127.0.0.1` | Listener interface. Keep local demos on loopback. |
| `PORT` | `3000` | Listener port, 1–65535. Keep it aligned with the public URL or proxy routing. |
| `TRUST_PROXY_HOPS` | `0` | Exact trusted proxy hop count, 0–3. Set only for a known proxy topology. |
| `DATABASE_URL` | Required | PostgreSQL connection URL. Non-loopback hosts use TLS with certificate verification. |
| `POSTGRES_PASSWORD` | Generated by setup | Used by the Compose database, not by the application config parser. Must match the database credentials in `DATABASE_URL`. |
| `DATA_ENCRYPTION_KEY` | Required; generated by setup | Canonical base64 encoding of exactly 32 bytes. Preserve it alongside durable data. |
| `ALLOWED_COUNTRIES` | `US` | Allowed two-letter uppercase country codes; explicitly set in sandbox mode. |
| `ALLOWED_CURRENCIES` | `USD` | Allowed ISO currency codes; explicitly set in sandbox mode. |
| `ALLOWED_MERCHANTS` | `{"mock-coffee":"Mock Coffee Roasters"}` | JSON map of local merchant keys to names. Keys use lowercase letters, digits, `_`, or `-`, up to 64 characters, starting with a letter/digit. Explicitly set in sandbox mode. |
| `ALLOW_ALL_MERCHANTS` | `false` | Explicitly allow provider-returned merchants. An empty merchant map is otherwise invalid. |
| `PURCHASE_CAPS` | Required; template has `{"USD":"100.00"}` | Positive decimal-string cap for every allowed currency. |
| `CATALOG_URL_HOSTS` | Empty | Exact allowed image hostnames. Images from other hosts are omitted with a warning. |
| `ALLOWED_ORIGINS` | Empty | Additional exact browser origins. The public URL's origin is always included. |

### Local identity and mock behavior

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_DEMO_SUBJECT` | `demo` | Stdio identity subject. Keep stable to retain access to that identity's saved resources. |
| `LOCAL_DEMO_EMAIL` | `demo@example.invalid` | Local profile email for enrollment and order contact. |
| `LOCAL_DEMO_EMAIL_VERIFIED` | `false` | Operator-confirmed email verification for sandbox stdio. Mock profiles are treated as verified independently of this flag. Do not enable it merely to bypass enrollment requirements. |
| `MOCK_SCENARIO` | `success` | One of the eight scenarios above. Non-success scenarios are rejected in sandbox mode. |

### Timeouts and retention settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPSTREAM_TIMEOUT_MS` | `20000` | Total time budget for ordinary provider HTTP calls, 100–60000 ms. |
| `STATUS_TIMEOUT_MS` | `5000` | Time budget for enrollment/checkout status reads, 100–10000 ms. |
| `RECOVERY_INTERVAL_MS` | `10000` | Background recovery interval, 1000–60000 ms; recovery also starts immediately at application startup. |
| `PII_RETENTION_HOURS` | `72` | Sets purchase delivery-data expiry, 48–720 hours. Expiry prevents using the data for a new checkout; it does not automatically erase stored data. |
| `AUDIT_RETENTION_DAYS` | `30` | Validated setting, 1–365 days. No audit-purge worker currently consumes it. |

### Optional Reap sandbox settings

These are not required for local mocks. Checkout/simulation flags must remain false in mock mode.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REAP_BASE_URL` | `https://sg.sandbox.api.reap.global` | Allowed sandbox origin. Also accepts `https://mx.sandbox.api.reap.global` or `https://sandbox.api.reap.global`; arbitrary and production hosts are rejected. |
| `REAP_API_KEY` | Empty | Required private project credential in sandbox mode. Never expose it to MCP tool inputs or logs. |
| `REAP_API_VERSION` | `2025-02-14` | The only accepted API version. |
| `REAP_PROJECT_REFERENCE` | Empty | Required stable application namespace label for a sandbox project; not a Reap request parameter. |
| `REAP_HOSTED_URL_HOSTS` | Empty | Reap-confirmed exact HTTPS hostnames allowed for setup/approval redirects; required before enrollment and checkout. |
| `REAP_MONEY_UNIT` | `unverified` | `major` or `minor` only after confirming the API contract. The documented API version uses native currency precision (`major`). Prices/quotes are blocked while unverified. |
| `REAP_CHECKOUT_ENABLED` | `false` | Explicit checkout enablement, still subject to all other gates. |
| `REAP_RETURN_URL_CONFIRMED` | `false` | Operator confirmation that HTTPS callbacks work correctly. |
| `REAP_PER_PURCHASE_APPROVAL_CONFIRMED` | `false` | Confirmation of a user-controlled hosted approval step for each non-simulated checkout. |
| `REAP_APPROVAL_VERIFICATION_REF` | Empty | Reference to the approval verification evidence, up to 300 characters. Required with approval confirmation for non-simulated checkout. |
| `SANDBOX_SIMULATE_CHECKOUT` | `false` | Sends `X-Simulate-Checkout: COMPLETED` to the actual sandbox API. It is not local mock mode and still requires checkout, money-unit, callback, and hosted-host gates. |

### Optional HTTP OAuth settings

Only used by the HTTP entry point, not stdio. Issuer, audience, and allowed subjects are required; other entries override discovery or claim defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OAUTH_ISSUER` | Empty | Required exact HTTPS issuer. |
| `OAUTH_AUDIENCE` | Empty | Must equal `PUBLIC_BASE_URL` plus `/mcp` exactly. |
| `OAUTH_JWKS_URI` | Empty | Explicit signing-key URL, or use discovery. A cross-host JWKS endpoint requires explicit configuration. |
| `OAUTH_METADATA_URL` | Empty | Override discovery URL on the issuer's HTTPS host; otherwise use its root `/.well-known/oauth-authorization-server`. |
| `OAUTH_SCOPES_CLAIM` | `scope` | Claim containing a space-separated string or array of scopes. |
| `OAUTH_EMAIL_CLAIM` | `email` | Profile email claim. |
| `OAUTH_EMAIL_VERIFIED_CLAIM` | `email_verified` | Must contain boolean `true` to verify the email. |
| `ALLOWED_SUBJECTS` | Empty | Required comma-separated allowlist of OAuth subject IDs. |

`TEST_DATABASE_URL` is separate test-only configuration; see [Development and testing](#development-and-testing). It is not an application fallback for `DATABASE_URL`.

## Architecture and code map

```text
MCP client
  |-- stdio-main.ts: local configured identity + browser callback server
  `-- http-main.ts: OAuth discovery + authenticated HTTP MCP
                |
              mcp.ts                 tool discovery and result formatting
                |
           commerce.ts               validation, ownership, budgets, state transitions
            /        \
     operations.ts    Provider       durable writes / provider reads
            |         |-- providers/mock.ts: database-backed simulation
            |         `-- providers/reap.ts: sandbox HTTP adapter
            `--------- db.ts         PostgreSQL, encryption, locks, audit, migrations
```

| File / directory | Responsibility |
| --- | --- |
| [src/config.ts](src/config.ts) | Environment loading/validation, namespace derivation, shared checkout prerequisites. |
| [src/domain.ts](src/domain.ts) | Provider interface, normalized domain types, purchase and operation states. |
| [src/schemas.ts](src/schemas.ts) | Strict public Zod contracts and response schemas. |
| [src/mcp.ts](src/mcp.ts) | Exactly five tool definitions, annotations, and text/structured result envelopes. |
| [src/commerce.ts](src/commerce.ts) | Application workflows, owner checks, quote revisions, caps, callbacks, recovery application. |
| [src/operations.ts](src/operations.ts) | Immutable provider requests, integrity hashes, idempotency keys, retry windows, durable results. |
| [src/providers/mock.ts](src/providers/mock.ts) | Catalog fixtures, simulated resources/consent, injected failure scenarios. |
| [src/providers/reap.ts](src/providers/reap.ts) | Wire-contract validation, lossless monetary parsing, safe hosted URLs, bounded HTTP retries and error mapping. |
| [src/db.ts](src/db.ts) | Pooling, transactions, connection-scoped advisory locks, scoped queries, audit/rate limits, migrations. |
| [src/runtime.ts](src/runtime.ts) | Database/provider composition and background recovery lifecycle. |
| [src/auth.ts](src/auth.ts), [src/http.ts](src/http.ts) | OAuth/JWT checks, HTTP transport, browser pages, Host/Origin checks, mock CSRF protection. |
| [src/stdio-main.ts](src/stdio-main.ts), [src/http-main.ts](src/http-main.ts) | Process startup, listeners/transports, signal handling. |
| [src/security.ts](src/security.ts), [src/money.ts](src/money.ts), [src/errors.ts](src/errors.ts) | Encryption/hashing/escaping, decimal money arithmetic, safe errors and stderr logging. |
| [src/migrate.ts](src/migrate.ts), [migrations/](migrations/) | Explicit database migration entry point and versioned SQL. |
| [scripts/setup-local.ts](scripts/setup-local.ts) | Non-overwriting private mock configuration generation. |
| [scripts/sandbox-check.ts](scripts/sandbox-check.ts) | Optional read-only sandbox catalog diagnostic; no database or payment writes. |
| [test/](test/) | Unit, stubbed provider/MCP contract, and PostgreSQL mock integration tests. |

The `Provider` interface keeps transport-specific payloads out of the public MCP contract. It separates request construction from execution so a mutation's exact body and headers can be persisted before sending. Reads do not create durable write operations.

## State, idempotency, and recovery

### Purchase lifecycle

| State | Meaning |
| --- | --- |
| `PREPARING` | A quote operation has been saved and is being resolved. |
| `READY` | A quoted draft can be reviewed, modified, or requested at its current revision. |
| `UPDATING_QUOTE` | A shipping change is pending. |
| `CREATING_CHECKOUT` | The durable checkout operation exists; do not create another. |
| `REQUIRES_ACTION` | The user must act on the hosted approval page. |
| `PROCESSING` | The existing checkout is processing. |
| `COMPLETED` | The provider reports completion; check receipt/charged amount and reconciliation warnings. |
| `FAILED` / `EXPIRED` | This attempt cannot be reused as a new checkout. Any new purchase needs a new user-directed preparation and review. |
| `UNKNOWN_RECONCILIATION_REQUIRED` | The outcome or contract could not be safely established; preserve the existing purchase and investigate. |

Preparation and shipping changes increment a quote revision. Immediately before checkout, the server refreshes the quote. Material changes return `REVIEW_REQUIRED` with the updated revision, without creating checkout. A stale `expected_revision`, inactive enrollment, unsupported region/merchant, expired data, or excessive total blocks submission.

### Durable write protocol

1. Save the local resource, callback reference where needed, immutable encrypted provider request, hash, and idempotency key in a transaction.
2. Mark the operation in flight before executing it through the provider.
3. Persist the provider response, then apply it to the purchase/enrollment transactionally.
4. On uncertain failures, retain the operation and retry only the same request/key within the safe window.

PostgreSQL uniqueness constraints enforce one checkout operation per purchase, and advisory locks serialize conflicting work across application processes. A changed input under the same preparation key is an `IDEMPOTENCY_CONFLICT`, not a new operation.

Operations have `PREPARED`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED`, or `UNKNOWN` status. `applied_at` distinguishes a persisted response from one already applied to domain state. Recovery processes up to five eligible unapplied operations per tick and does not overlap ticks within a process.

Same-key replay is allowed conservatively within the 24-hour provider idempotency window, leaving a one-minute margin. Expired/unavailable replay data is marked for reconciliation rather than assigned a fresh key. Retry scheduling respects provider delays with a minimum five-second operation backoff.

`get_purchase_status` and browser callbacks do not replay writes. Background recovery and explicit retries of the original mutating tool may resume eligible operations. Consequently, **starting an application process is not a read-only diagnostic**, even before a client sends a new tool call.

An approval bypass, charged-amount mismatch, or checkout contract anomaly can persist a namespace-wide checkout block in `provider_controls`. There is no automatic unblock or public reset tool. Investigate the saved operation and provider outcome before an operator changes that control.

## Storage and security boundaries

### Database layout

| Tables | Stored responsibility |
| --- | --- |
| `users`, `payment_methods` | Authenticated issuer/subject identity, generated owner reference, encrypted profile and enrollment details. |
| `catalog_items`, `search_cursors` | User/namespace-scoped catalog handles and encrypted provider cursors with expiry. |
| `purchases`, `operations` | Selected terms, revisions, states, encrypted private details and immutable request/response journal. |
| `callbacks` | Hashed opaque callback references bound to a resource, owner, namespace, and expiry. |
| `provider_controls`, `audit_events`, `rate_windows` | Checkout kill switch, minimized audit history, and rate-limit/fault counters. |
| `mock_resources`, `mock_replays` | Encrypted simulated provider state and durable idempotency responses. |
| `schema_migrations` | Migration names and checksums; created by the migration runner. |

Mock data uses namespace `mock:v1`. Sandbox namespaces include the stable project reference, provider host, and API version. Namespace changes intentionally separate provider resources; they do not migrate or delete old data. `LOCAL_DEMO_SUBJECT` changes which local identity can access saved records.

Private profiles, delivery/contact information, enrollment/approval links, operation payloads, and provider cursors are encrypted with AES-256-GCM. Each value uses a fresh nonce and is bound to its resource/purpose as authenticated data. Callback and mock-link tokens are stored as hashes. Public purchase views expose only a country and masked postal prefix for delivery.

### Trust boundaries

- OAuth identity or the operator-configured stdio identity owns resources; tool arguments cannot choose another owner.
- Card entry occurs only on hosted pages. PAN, CVV, issuer credentials, and conversational approval fields are not accepted by the tool schemas.
- Merchant content is untrusted data, not an instruction to spend money. Display text is sanitized/escaped, and returned URLs must match exact configured hosts.
- Money uses decimal arithmetic and lossless provider JSON parsing, not floating-point addition. Unknown amounts and unknown provider states are not silently turned into success.
- Browser routes enforce configured Host/Origin boundaries and restrictive response headers. Mock consent POSTs require a same-site nonce cookie, signed CSRF token, matching origin, and a valid resource-bound link.
- Callback references act as temporary bearer capabilities: possession permits a bounded recheck of that resource. If an Authorization header is supplied, it must also match the owner. Keep these URLs private.
- Audit and application logs retain controlled fields and trace IDs rather than secrets, full upstream responses, card details, or delivery addresses.

### Retention is not automatic deletion

Expiry checks prevent using expired delivery data, cursors, callback references, and approval links. **There is currently no scheduled purge of encrypted payloads, audit history, expired handles, rate windows, or mock resources.** `AUDIT_RETENTION_DAYS` does not yet enforce deletion. Plan storage/privacy retention before a real deployment; do not mistake a configured expiry for erasure, and do not delete unresolved payment records as a cleanup shortcut.

## Authenticated HTTP transport

HTTP MCP is optional. It requires an external OAuth authorization server; this repository does not implement an issuer or login UI. OAuth discovery/JWKS may use external network access even when the commerce provider is mocked.

Configure the HTTPS public origin, exact `/mcp` audience, issuer, allowed subjects, and appropriate tool scopes. The issuer must expose matching metadata, authorization-code support with S256 PKCE, and either dynamic client registration or client ID metadata documents. Tokens require `exp`, `sub`, `iss`, and `aud`; signature algorithms are limited to RS256 and ES256.

Then use either source or compiled startup:

```sh
npm run dev
```

```sh
npm run build
npm start
```

Remote HTTP never falls back to the local demo identity. If HTTPS is terminated by a proxy, configure the real `TRUST_PROXY_HOPS` count and preserve the public Host header. Keep the application port private behind the proxy.

| Endpoint | Availability / behavior |
| --- | --- |
| `GET /` | Connection guidance, not a shopping UI. |
| `GET /health` | Database connectivity check and provider mode; still subject to Host/Origin checks. |
| `GET /style.css` | Browser-page styling. |
| `/mcp` | Authenticated MCP in HTTP mode; `503 remote_mcp_disabled` in stdio processes. |
| `OPTIONS /mcp` | CORS preflight in HTTP mode for configured origins. |
| `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` | Protected-resource metadata in HTTP mode. |
| `GET /.well-known/oauth-authorization-server` | Discovered authorization-server metadata in HTTP mode. |
| `GET /status/:purchaseId` | Authenticated owned status view with `commerce:read`; use MCP status checks for local stdio. |
| `GET /callbacks/payment-method?ref=...` | Verify the existing enrollment using a bound callback reference. |
| `GET /callbacks/purchase?ref=...` | Recheck the existing purchase; never evidence of approval by itself. |
| `GET/POST /mock/enrollment/:token` | Mock-only card-setup page and explicit consent. |
| `GET/POST /mock/approval/:token` | Mock-only purchase review and explicit approval/decline. |

Tool calls have a database-backed limit of 60 per user/namespace per minute. Browser/HTTP requests also have a per-process, per-socket-IP limit of 180 per minute; clients behind the same proxy can share that limit.

## Optional Reap sandbox integration

**Skip this section for mock development.** Unlike local mocks, `APP_MODE=sandbox` makes real requests to Reap's sandbox service. Stubbed contract tests are not evidence that a particular project's live features or merchant coverage have been enabled.

The adapter targets the [Reap API reference](https://docs.reap.global/api-reference/overview), version `2025-02-14`, and restricts requests to the documented sandbox hosts.

Before using sandbox tools:

1. Obtain the project credential privately and explicitly configure supported countries, currencies, and merchants. Keep a stable `REAP_PROJECT_REFERENCE`; use a distinct value for another project.
2. Confirm monetary units. For the documented native-currency-precision contract, use `REAP_MONEY_UNIT=major`.
3. Supply an HTTPS `PUBLIC_BASE_URL` and verified hosted-page hostnames. A local tunnel can forward callbacks to the stdio process, with the correct proxy-hop count. Temporary tunnel URLs must be updated when they change, and the tunnel must remain running.
4. Enrollment needs a verified identity email and user-completed hosted card entry. Do not set `LOCAL_DEMO_EMAIL_VERIFIED` without operator confirmation or infer enrollment success from missing card metadata.
5. Leave checkout disabled until callback behavior, hosted hosts, monetary units, and per-purchase hosted approval have been verified. Non-simulated checkout requires both approval confirmation and an evidence reference in addition to checkout enablement.

`SANDBOX_SIMULATE_CHECKOUT=true` is a separate, operator-controlled upstream simulation mechanism, not a shortcut to local mocks. The persisted request's simulation header is checked again during execution; changing a process setting cannot authorize a previously saved non-simulated request without its required approval gates.

### Read-only catalog diagnostic

With sandbox configuration deliberately prepared, this command checks catalog search and details without opening a database or starting recovery:

```sh
npm run sandbox:check -- --query coffee --country US --currency USD
```

Optional flags are `--limit` (1–10), `--merchant`, `--max-item-price`, `--product-id`, and repeatable `--option-id`. A product ID is required when passing option IDs; the checker does not invent variant choices. IDs printed here are **provider IDs**, not local IDs usable in MCP tools.

This diagnostic never creates enrollments, quotes, or checkouts. Its result labels the purchase flow `NOT_TESTED`, and an empty catalog is not a successful purchase test. The `--help` option prints usage without loading environment configuration or making network requests.

Any sandbox enrollment, quote, or checkout exercise is a separate user-approved action. Do not start the full sandbox runtime merely to test connectivity: startup recovery can resume saved writes.

## Development and testing

### Commands

| Command | Effect |
| --- | --- |
| `npm run setup:local` | Generate a private mock `.env` only if it does not already exist. |
| `npm run dev:stdio` | Run source stdio MCP plus callback pages; requires the configured database. |
| `npm run dev` | Run source HTTP MCP with OAuth discovery; requires the configured database. |
| `npm run build` | Compile `src/` to `dist/`, including declaration files and source maps. |
| `npm run start:stdio` | Launch compiled stdio MCP and callback pages. |
| `npm start` | Launch compiled HTTP MCP. |
| `npm run typecheck` | Typecheck source, scripts, and tests without emitting files. |
| `npm test` | Unit and stubbed provider/MCP contract tests; no Reap calls or PostgreSQL service required. |
| `npm run test:db` | Mock integration tests against an explicitly configured dedicated local test database. |
| `npm run check` | Typecheck, unit/contract tests, and build. Does not include `test:db` or live sandbox diagnostics. |
| `npm run db:migrate` | Apply checksum-verified SQL migrations to `DATABASE_URL`. |
| `npm run sandbox:check -- --help` | Print optional sandbox diagnostic usage without API calls. |

The default tests construct their own configuration and use stubbed provider/database behavior; they do not load the private application `.env`. MCP contract tests use in-memory transports, with a loopback server on an ephemeral port for callback-server routing checks.

Coverage includes strict schemas/scopes, money precision, encryption/URL boundaries, mock filtering and quote consistency, sandbox payload mapping with stubbed fetch, checkout gates during construction/replay, complete text-only MCP results, and conservative replay windows. The database suite additionally exercises persisted tool flows, revisions, owner isolation, browser CSRF/callback handling, concurrency, and uncertain checkout recovery.

### PostgreSQL integration tests

Provide `TEST_DATABASE_URL` through a private environment configuration. It must identify a **local, dedicated PostgreSQL database whose name contains `test`**. The suite refuses a missing URL, a non-loopback host, or an unsuitable database name. Vitest does not automatically load this value from the application's `.env`.

For the bundled local database service, you can create a dedicated database once:

```sh
docker compose exec -T db createdb -U reap reap_mcp_test
```

Configure a URL with the corresponding credentials, host port `55432`, and database name `reap_mcp_test`; do not point it at `reap_mcp`. Then run:

```sh
npm run test:db
```

Each run creates a unique schema and retains it. Tests do not truncate tables, reset the application database, or call live payment APIs. Test schemas accumulate; any later removal should be a deliberate operation limited to verified test data.

### Making changes

- Keep tool shapes in `schemas.ts`, domain/provider contracts in `domain.ts`, and provider-specific mapping behind `Provider`.
- Add regression tests before fixing behavior. Use the existing mock provider or injected `fetch` stubs rather than real sandbox calls.
- Preserve ownership checks, immutable request replay, exact revisions, and user-completed browser approval when refactoring.
- Add a new SQL migration when the schema changes; never edit an already-applied migration. Keep public contracts and this README aligned with behavior.
- Run `npm run check`, run `test:db` when a dedicated database is available, rebuild, and reconnect compiled MCP clients.

See [AGENTS.md](AGENTS.md) for repository-specific agent development rules.

## Deployment and operations

### Containers

```sh
docker build -t reap-mcp .
```

The multi-stage Dockerfile installs pinned dependencies with `npm ci`, builds TypeScript, removes development dependencies, and runs as the non-root `node` user. It starts `node dist/http-main.js`, so it requires the HTTP/OAuth configuration above. It is not a ready-to-run unauthenticated mock web app.

Inject secrets at runtime, not in the image. Configure a database reachable from the container: a host-loopback database URL does not refer to the host machine from inside a normal container. A non-loopback database connection requires a trusted TLS certificate. For a container reached by a reverse proxy, use `BIND_HOST=0.0.0.0`, a verified HTTPS `PUBLIC_BASE_URL`, and the correct proxy-hop count; expose the application port only to the intended proxy/network. The default loopback listener is not reachable from other containers. The example Compose file is a local database service, not an application deployment manifest.

Apply migrations explicitly before application startup. In a built installation or runtime image, use:

```sh
node dist/migrate.js
```

The application verifies that migrations have been initialized but does not apply them automatically. The runtime image does not contain the source-based setup/diagnostic scripts or their `tsx` development runner.

### Routine operation

- Check `/health` through the configured origin. It verifies database connectivity, not Reap credentials, merchant coverage, or checkout readiness.
- Keep the database and encryption key together in a secure backup strategy. Losing the key prevents reading durable private requests and results.
- Logs are JSON on stderr with event names and controlled diagnostic fields. Use `trace_id` and audit records to investigate failures without printing secrets or full payloads.
- SIGINT/SIGTERM stop listeners and close the runtime/recovery resources. Saved operations remain available for recovery at the next start.
- Stop the local database with `docker compose stop db` when appropriate; its named volume is retained. Do not reset a volume or regenerate credentials to troubleshoot uncertain purchases.
- Investigate reconciliation flags and provider checkout blocks before attempting new purchases. There is no built-in operator reconciliation dashboard or automated retention job.

## Troubleshooting

| Symptom / code | What to check |
| --- | --- |
| `.env already exists and was left unchanged` | Expected setup behavior. Review nonsecret mode/URL/merchant settings and preserve existing credentials. Setup does not switch a sandbox installation to mocks. |
| `CONFIG_ERROR` | Check the named fields against `.env.example` and the configuration tables. Required URLs, flags, encryption-key encoding, and currency caps are validated; values are intentionally not logged. |
| Startup cannot query `schema_migrations` | Start the intended database and run migrations against that database. A working connection alone does not initialize the schema. |
| Database password errors after changing `.env` | A persisted PostgreSQL volume keeps its original credentials. Correct the connection configuration; do not discard application data. |
| `pages_listen_failed` / `http_listen_failed` | Another process may own `PORT`. Give each MCP subprocess its own port and matching public URL. |
| `npm run dev` asks for OAuth | It starts the authenticated HTTP entry point. For local mocks, connect through `dev:stdio` or `start:stdio`. |
| `/mcp` returns `remote_mcp_disabled` | Expected for stdio processes. The browser listener serves callbacks, not unauthenticated MCP. |
| `invalid_host`, `invalid_origin`, or `https_required` | Match the configured hostname/origin, preserve Host through a proxy, and confirm trusted proxy hops/HTTPS. Do not disable the checks. |
| `AUTH_REQUIRED` / HTTP 401 | Check issuer, audience, token expiry/signature, and discovery/JWKS configuration. |
| `FORBIDDEN` / HTTP 403 | Check owner identity, subject allowlist, required scope, resource namespace, or expired capability link. |
| `NEEDS_INPUT` | Ask for exactly the returned missing fields/options. Do not guess an address, variant, or verified email. |
| `INVALID_CURSOR` / `PRODUCT_UNAVAILABLE` | Search again under the same intended identity, country, currency, and merchant policy. Keep cursor criteria unchanged between pages. |
| `REVISION_MISMATCH` / `REVIEW_REQUIRED` | Show the latest terms and use their revision only after user review. Do not silently accept a changed total. |
| `BUDGET_EXCEEDED` | The authoritative total exceeds the user budget or server cap. Prepare a user-approved revised selection; do not relax the cap automatically. |
| `PAYMENT_METHOD_NOT_ACTIVE` | Complete/recheck the original hosted enrollment using `connect_payment_method`. |
| `OPERATION_PENDING`, `CHECKOUT_PENDING`, or rate-limit errors | Recheck saved state or retry the original request after the indicated delay. Do not create duplicate purchases or rotate keys. |
| `UPSTREAM_UNAVAILABLE` / unknown outcome | Keep the purchase ID and original operation. A timeout does not prove that checkout failed. Status reads are safe but do not replay pending writes. |
| `REAP_FEATURE_NOT_ENABLED` | Sandbox capability or operator-confirmed gates are missing. Verify the project and prerequisites; do not enable flags merely to make a test pass. |
| `STORAGE_ERROR` | Check that the original encryption key is available. Do not reset purchases or replace the key to hide unreadable records. |
| `RECONCILIATION_REQUIRED` or completed-with-warnings | Investigate the existing provider outcome, charged amount, order reference, and checkout controls before further action. |
| Old tool output after a source change | Run the build and reconnect the MCP client so it launches the new compiled code. |
| `test:db` refuses to start | Set a dedicated local `TEST_DATABASE_URL` with `test` in the database name; ordinary unit/contract tests do not need it. |

## Current limitations

- One product variant per purchase, quantity 1–10. No multi-item cart, refunds, cancellation tool, saved-address management, or card-management UI.
- The mock catalog models a small USD-oriented fixture, not real inventory, shipping validation, foreign exchange, or merchant coverage. Details/variant fixtures use the first configured currency; multi-currency mock searches are not a complete end-to-end simulation.
- Mock mode still needs PostgreSQL for application use. Only the default unit/contract suite runs without a database service.
- Sandbox behavior depends on the project's enabled features and verified hosted approval flow. Mock or stubbed tests do not certify live checkout, and production API hosts are rejected.
- No automatic data purging, key-rotation workflow, reconciliation dashboard, or automatic checkout unblock. These require explicit operational design before deployment with real user data.
- No bundled OAuth issuer, application-level CI workflow, or full deployment stack. The included Dockerfile and database Compose service are building blocks, not a production-readiness claim.
- Status comes from provider reads and saved state. Browser callbacks are not signed payment-success notifications or proof of approval.
