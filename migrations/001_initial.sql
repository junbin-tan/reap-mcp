CREATE TABLE users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  owner_reference text NOT NULL UNIQUE,
  profile_ciphertext text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  enrollment_id text,
  status text NOT NULL,
  details_ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id, namespace),
  UNIQUE (namespace, enrollment_id)
);
CREATE UNIQUE INDEX one_current_method ON payment_methods (user_id, namespace)
  WHERE status IN ('CREATING', 'REQUIRES_ACTION', 'ACTIVE', 'UNKNOWN_RECONCILIATION_REQUIRED');

CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  operation_key text NOT NULL,
  input_hash text NOT NULL,
  selection jsonb NOT NULL,
  private_ciphertext text,
  quote jsonb,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state text NOT NULL CHECK (state IN ('PREPARING', 'READY', 'UPDATING_QUOTE', 'CREATING_CHECKOUT', 'REQUIRES_ACTION', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED', 'UNKNOWN_RECONCILIATION_REQUIRED')),
  provider_status text,
  checkout_id text,
  checkout_data jsonb,
  link_ciphertext text,
  payment_method_id uuid,
  budget text,
  simulated boolean NOT NULL,
  reconciliation_required boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  pii_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, namespace, operation_key),
  UNIQUE (id, user_id, namespace),
  UNIQUE (namespace, checkout_id),
  FOREIGN KEY (payment_method_id, user_id, namespace) REFERENCES payment_methods(id, user_id, namespace)
);

CREATE TABLE operations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('enrollment', 'quote', 'shipping', 'checkout')),
  purchase_id uuid,
  payment_method_id uuid,
  logical_key text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  request_ciphertext text,
  response_ciphertext text,
  provider_id text,
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  error_code text,
  upstream_code text,
  first_sent_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, idempotency_key),
  UNIQUE (user_id, namespace, kind, logical_key),
  FOREIGN KEY (purchase_id, user_id, namespace) REFERENCES purchases(id, user_id, namespace),
  FOREIGN KEY (payment_method_id, user_id, namespace) REFERENCES payment_methods(id, user_id, namespace),
  CHECK ((purchase_id IS NULL) <> (payment_method_id IS NULL)),
  CHECK ((kind = 'enrollment') = (payment_method_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_checkout_per_purchase ON operations (purchase_id) WHERE kind = 'checkout';
CREATE INDEX recover_operations ON operations (namespace, next_attempt_at) WHERE applied_at IS NULL;

CREATE TABLE catalog_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  provider_product_id text NOT NULL,
  country text NOT NULL,
  currency text NOT NULL,
  merchant_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (user_id, namespace, provider_product_id, country, currency)
);
CREATE TABLE search_cursors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  context_hash text NOT NULL,
  cursor_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE callbacks (
  reference_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  namespace text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('payment-method', 'purchase')),
  resource_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE provider_controls (
  namespace text PRIMARY KEY,
  checkout_blocked boolean NOT NULL DEFAULT false,
  reason text,
  blocked_at timestamptz
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  namespace text NOT NULL,
  resource_id uuid,
  tool text NOT NULL,
  outcome text NOT NULL,
  trace_id uuid NOT NULL,
  differences jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_time ON audit_events (created_at);
CREATE TABLE rate_windows (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE TABLE mock_resources (
  id uuid PRIMARY KEY,
  namespace text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('enrollment', 'quote', 'checkout')),
  data_ciphertext text NOT NULL,
  access_hash text UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mock_replays (
  namespace text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  response_ciphertext text NOT NULL,
  PRIMARY KEY (namespace, idempotency_key)
);
