import Database from 'better-sqlite3';

export const CONVERSATION_SCHEMA_VERSION = 8;

const INITIAL_SCHEMA_CHECKSUM =
  'sha256:adef33240904073d81a464ea6dda799046546d240fa7572fdf1887a96adb7bbf';
const IDENTITY_SCHEMA_CHECKSUM =
  'sha256:5d725517ef088c7f6f547593c60ebec0fa41d89a3e14681f7ad2a14bb88b89b4';
const AUTHORIZATION_POLICY_CHECKSUM =
  'sha256:4e20020fdbca6e8e696ce41806f1483a89325a4a4682a16c6b0ae08b12bf03c0';
const USER_DATA_OWNERSHIP_CHECKSUM =
  'sha256:10714e68a69b04f9f4097ee375513f58c9a0b5c53f576d4d2fc0bda56fac402d';
const SERVICE_DATA_OWNERSHIP_CHECKSUM =
  'sha256:2fc90201f00affc19a289dd7e2402fb28ecbf82fb7d3aac8aac24275cb82d998';
const ADMIN_CONTROL_PLANE_CHECKSUM =
  'sha256:70a40563955ba82bb10320c03e8ccfd7fc07bb15fbb9f3b8d140c9f457ce6af7';
const PERSONAL_INTEGRATIONS_CHECKSUM =
  'sha256:519d0ae7d780d40411279378294a4ef42acdc5bc55e805469313a38592760faa';
const SIMPLE_HOME_ROLES_CHECKSUM =
  'sha256:f4429f57d6a0dce5a2fcd7536df971596e4cc14a60fa16d6c98910970b9ec4c2';

function ensureAuthorizationPolicy(db: Database.Database): void {
  const grants: Record<string, readonly string[]> = {
    owner: [
      'chat',
      'history',
      'mail',
      'calendar',
      'todo',
      'music',
      'home',
      'cameras',
      'admin',
      'nas.operations',
    ],
    resident: ['chat', 'history', 'mail', 'calendar', 'todo', 'music', 'home'],
    guest: ['chat', 'music', 'home'],
  };
  const insert = db.prepare(
    'INSERT OR IGNORE INTO role_permissions(role_key, permission_key) VALUES (?, ?)'
  );
  for (const [role, permissions] of Object.entries(grants)) {
    for (const permission of permissions) insert.run(role, permission);
  }
}

function ensureIdentitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email_normalized TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending','active','suspended','rejected','revoked')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_login_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS oidc_identities (
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email_verified INTEGER NOT NULL CHECK (email_verified IN (0,1)),
      created_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      PRIMARY KEY (issuer, subject),
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_oidc_identities_user ON oidc_identities(user_id);
    CREATE TABLE IF NOT EXISTS roles (
      role_key TEXT PRIMARY KEY CHECK (role_key IN ('owner','admin','resident','guest')),
      rank INTEGER NOT NULL UNIQUE CHECK (rank BETWEEN 10 AND 100)
    );
    CREATE TABLE IF NOT EXISTS permissions (
      permission_key TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      granted_at_ms INTEGER NOT NULL,
      PRIMARY KEY(user_id, role_key),
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY(role_key) REFERENCES roles(role_key) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_key TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      PRIMARY KEY(role_key, permission_key),
      FOREIGN KEY(role_key) REFERENCES roles(role_key) ON DELETE CASCADE,
      FOREIGN KEY(permission_key) REFERENCES permissions(permission_key) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_session_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
      revoked_at_ms INTEGER,
      last_seen_at_ms INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_provider
      ON auth_sessions(provider_session_id) WHERE provider_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_status
      ON auth_sessions(user_id, status, expires_at_ms DESC);
  `);
  const roles = [
    ['owner', 100],
    ['resident', 50],
    ['guest', 10],
  ] as const;
  const permissions = [
    'chat',
    'history',
    'mail',
    'calendar',
    'todo',
    'music',
    'home',
    'cameras',
    'admin',
    'nas.operations',
  ];
  const insertRole = db.prepare('INSERT OR IGNORE INTO roles(role_key, rank) VALUES (?, ?)');
  const insertPermission = db.prepare(
    'INSERT OR IGNORE INTO permissions(permission_key) VALUES (?)'
  );
  roles.forEach(([key, rank]) => insertRole.run(key, rank));
  permissions.forEach((permission) => insertPermission.run(permission));
}

function ensureSimpleHomeRoles(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO user_roles(user_id,role_key,granted_at_ms)
      SELECT user_id,'owner',granted_at_ms FROM user_roles WHERE role_key='admin';
    DELETE FROM user_roles WHERE role_key='admin';
    UPDATE household_memberships SET role_key='owner' WHERE role_key='admin';
    DELETE FROM role_permissions WHERE role_key='admin';
    DELETE FROM roles WHERE role_key='admin';
  `);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function ensureUserDataOwnershipSchema(db: Database.Database): void {
  if (!hasColumn(db, 'conversation_threads', 'owner_user_id')) {
    db.exec(
      'ALTER TABLE conversation_threads ADD COLUMN owner_user_id TEXT REFERENCES users(user_id);'
    );
  }
  if (!hasColumn(db, 'pending_mutations', 'owner_user_id')) {
    db.exec(
      'ALTER TABLE pending_mutations ADD COLUMN owner_user_id TEXT REFERENCES users(user_id);'
    );
  }
  if (!hasColumn(db, 'conversation_result_sets', 'owner_user_id')) {
    db.exec(
      'ALTER TABLE conversation_result_sets ADD COLUMN owner_user_id TEXT REFERENCES users(user_id);'
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_threads_owner_updated
      ON conversation_threads(owner_user_id, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_mutations_owner_thread_status
      ON pending_mutations(owner_user_id, thread_id, status, expires_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_result_sets_owner_thread
      ON conversation_result_sets(owner_user_id, thread_id, expires_at_ms DESC);

    CREATE TABLE IF NOT EXISTS households (
      household_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS household_memberships (
      household_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL CHECK (role_key IN ('owner','admin','resident','guest')),
      status TEXT NOT NULL CHECK (status IN ('active','revoked')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(household_id, user_id),
      FOREIGN KEY(household_id) REFERENCES households(household_id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_household_memberships_user_status
      ON household_memberships(user_id, status, household_id);

    CREATE TABLE IF NOT EXISTS integration_connections (
      connection_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      household_id TEXT,
      provider TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('pending','active','error','revoked')),
      credential_reference TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY(owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY(household_id) REFERENCES households(household_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_owner_provider
      ON integration_connections(owner_user_id, provider, status);

    CREATE TABLE IF NOT EXISTS resource_grants (
      grant_id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      grantee_user_id TEXT,
      grantee_household_id TEXT,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      created_by_user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      CHECK ((grantee_user_id IS NOT NULL) <> (grantee_household_id IS NOT NULL)),
      FOREIGN KEY(grantee_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY(grantee_household_id) REFERENCES households(household_id) ON DELETE CASCADE,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_resource_grants_resource
      ON resource_grants(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_resource_grants_user
      ON resource_grants(grantee_user_id, resource_type);

    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','service','system')),
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','failed')),
      correlation_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_created
      ON audit_events(created_at_ms DESC, event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor
      ON audit_events(actor_kind, actor_id, created_at_ms DESC);
    CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events_append_only'); END;
  `);
}

function ensureServiceDataOwnershipSchema(db: Database.Database): void {
  if (!hasColumn(db, 'conversation_threads', 'owner_service_id')) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN owner_service_id TEXT;');
  }
  if (!hasColumn(db, 'pending_mutations', 'owner_service_id')) {
    db.exec('ALTER TABLE pending_mutations ADD COLUMN owner_service_id TEXT;');
  }
  if (!hasColumn(db, 'conversation_result_sets', 'owner_service_id')) {
    db.exec('ALTER TABLE conversation_result_sets ADD COLUMN owner_service_id TEXT;');
  }

  const invalid = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM conversation_threads
      WHERE owner_user_id IS NOT NULL AND owner_service_id IS NOT NULL) +
    (SELECT COUNT(*) FROM pending_mutations p
      LEFT JOIN conversation_threads t ON t.thread_id=p.thread_id
      WHERE t.thread_id IS NULL
         OR (p.owner_user_id IS NOT NULL AND p.owner_service_id IS NOT NULL)
         OR NOT (p.owner_user_id IS t.owner_user_id AND p.owner_service_id IS t.owner_service_id)) +
    (SELECT COUNT(*) FROM conversation_result_sets r
      LEFT JOIN conversation_threads t ON t.thread_id=r.thread_id
      WHERE t.thread_id IS NULL
         OR (r.owner_user_id IS NOT NULL AND r.owner_service_id IS NOT NULL)
         OR NOT (r.owner_user_id IS t.owner_user_id AND r.owner_service_id IS t.owner_service_id)) AS count`
    )
    .get() as { count: number };
  if (Number(invalid.count) > 0)
    throw new Error(`conversation_ownership_invariant_failed:${invalid.count}`);

  const ensureIndex = (name: string, createSql: string, expectedColumns: string[]) => {
    const columns = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>;
    if (columns.map((column) => column.name).join('\u001f') === expectedColumns.join('\u001f'))
      return;
    db.exec(`DROP INDEX IF EXISTS ${name};`);
    db.exec(createSql);
  };
  ensureIndex(
    'idx_conversation_threads_owner_updated',
    'CREATE INDEX idx_conversation_threads_owner_updated ON conversation_threads(owner_user_id, owner_service_id, updated_at_ms DESC);',
    ['owner_user_id', 'owner_service_id', 'updated_at_ms']
  );
  ensureIndex(
    'idx_pending_mutations_owner_thread_status',
    'CREATE INDEX idx_pending_mutations_owner_thread_status ON pending_mutations(owner_user_id, owner_service_id, thread_id, status, expires_at_ms DESC);',
    ['owner_user_id', 'owner_service_id', 'thread_id', 'status', 'expires_at_ms']
  );
  ensureIndex(
    'idx_conversation_result_sets_owner_thread',
    'CREATE INDEX idx_conversation_result_sets_owner_thread ON conversation_result_sets(owner_user_id, owner_service_id, thread_id, expires_at_ms DESC);',
    ['owner_user_id', 'owner_service_id', 'thread_id', 'expires_at_ms']
  );

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS conversation_threads_owner_insert
      BEFORE INSERT ON conversation_threads
      WHEN NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'conversation_owner_ambiguous'); END;
    CREATE TRIGGER IF NOT EXISTS conversation_threads_owner_update
      BEFORE UPDATE OF owner_user_id,owner_service_id ON conversation_threads
      WHEN NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'conversation_owner_ambiguous'); END;
    CREATE TRIGGER IF NOT EXISTS pending_mutations_owner_insert
      BEFORE INSERT ON pending_mutations
      WHEN (NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL)
        OR NOT EXISTS (
          SELECT 1 FROM conversation_threads t WHERE t.thread_id=NEW.thread_id
            AND t.owner_user_id IS NEW.owner_user_id
            AND t.owner_service_id IS NEW.owner_service_id
        )
      BEGIN SELECT RAISE(ABORT, 'pending_mutation_owner_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS pending_mutations_owner_update
      BEFORE UPDATE OF thread_id,owner_user_id,owner_service_id ON pending_mutations
      WHEN (NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL)
        OR NOT EXISTS (
          SELECT 1 FROM conversation_threads t WHERE t.thread_id=NEW.thread_id
            AND t.owner_user_id IS NEW.owner_user_id
            AND t.owner_service_id IS NEW.owner_service_id
        )
      BEGIN SELECT RAISE(ABORT, 'pending_mutation_owner_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS conversation_result_sets_owner_insert
      BEFORE INSERT ON conversation_result_sets
      WHEN (NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL)
        OR NOT EXISTS (
          SELECT 1 FROM conversation_threads t WHERE t.thread_id=NEW.thread_id
            AND t.owner_user_id IS NEW.owner_user_id
            AND t.owner_service_id IS NEW.owner_service_id
        )
      BEGIN SELECT RAISE(ABORT, 'conversation_result_set_owner_mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS conversation_result_sets_owner_update
      BEFORE UPDATE OF thread_id,owner_user_id,owner_service_id ON conversation_result_sets
      WHEN (NEW.owner_user_id IS NOT NULL AND NEW.owner_service_id IS NOT NULL)
        OR NOT EXISTS (
          SELECT 1 FROM conversation_threads t WHERE t.thread_id=NEW.thread_id
            AND t.owner_user_id IS NEW.owner_user_id
            AND t.owner_service_id IS NEW.owner_service_id
        )
      BEGIN SELECT RAISE(ABORT, 'conversation_result_set_owner_mismatch'); END;
  `);

  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error(`conversation_foreign_key_invariant_failed:${foreignKeyErrors.length}`);
  }
}

function ensureAdminControlPlaneSchema(db: Database.Database): void {
  if (!hasColumn(db, 'integration_connections', 'last_sync_at_ms')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN last_sync_at_ms INTEGER;');
  }
  if (!hasColumn(db, 'integration_connections', 'last_error_code')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN last_error_code TEXT;');
  }
  if (!hasColumn(db, 'integration_connections', 'revoked_at_ms')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN revoked_at_ms INTEGER;');
  }
  if (!hasColumn(db, 'resource_grants', 'revoked_at_ms')) {
    db.exec('ALTER TABLE resource_grants ADD COLUMN revoked_at_ms INTEGER;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_integration_connections_status_updated
      ON integration_connections(status, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_resource_grants_active_resource
      ON resource_grants(resource_type, resource_id, revoked_at_ms, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_audit_events_action_created
      ON audit_events(action, created_at_ms DESC, event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_target_created
      ON audit_events(target_type, target_id, created_at_ms DESC, event_id);

    CREATE TABLE IF NOT EXISTS admin_idempotency_keys (
      actor_user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(actor_user_id, idempotency_key),
      FOREIGN KEY(actor_user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_idempotency_created
      ON admin_idempotency_keys(created_at_ms);
  `);
}

function ensurePersonalIntegrationsSchema(db: Database.Database): void {
  if (!hasColumn(db, 'integration_connections', 'connection_kind')) {
    db.exec("ALTER TABLE integration_connections ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'personal';");
  }
  if (!hasColumn(db, 'integration_connections', 'display_name')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN display_name TEXT;');
  }
  if (!hasColumn(db, 'integration_connections', 'provider_subject')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN provider_subject TEXT;');
  }
  if (!hasColumn(db, 'integration_connections', 'provider_email')) {
    db.exec('ALTER TABLE integration_connections ADD COLUMN provider_email TEXT;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_credentials (
      credential_id TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      key_version INTEGER NOT NULL CHECK (key_version > 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_transactions (
      state_hash TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY(connection_id) REFERENCES integration_connections(connection_id) ON DELETE CASCADE,
      FOREIGN KEY(owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_transactions_expiry
      ON oauth_transactions(expires_at_ms, consumed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_integration_connections_household_provider
      ON integration_connections(household_id, provider, status);
    CREATE INDEX IF NOT EXISTS idx_integration_connections_personal_active
      ON integration_connections(owner_user_id, provider)
      WHERE connection_kind='personal' AND status <> 'revoked';
    CREATE INDEX IF NOT EXISTS idx_integration_connections_shared_active
      ON integration_connections(household_id, provider, display_name)
      WHERE connection_kind='household_shared' AND status <> 'revoked';
    CREATE TRIGGER IF NOT EXISTS integration_connections_delete_credential
      BEFORE DELETE ON integration_connections
      WHEN OLD.credential_reference IS NOT NULL
      BEGIN
        DELETE FROM integration_credentials WHERE credential_id=OLD.credential_reference;
      END;
  `);

  db.exec(`
    DELETE FROM integration_credentials
    WHERE NOT EXISTS (
      SELECT 1 FROM integration_connections c
      WHERE c.credential_reference=integration_credentials.credential_id
    );
  `);

  const invalidKinds = db.prepare(
    "SELECT COUNT(*) count FROM integration_connections WHERE connection_kind NOT IN ('personal','household_shared')"
  ).get() as { count: number };
  if (invalidKinds.count > 0) throw new Error('integration_connection_kind_invariant_failed');
}

/**
 * Creates the current additive schema and repairs databases created by the
 * pre-migration bootstrap. Keeping these statements idempotent is deliberate:
 * old Jarvis databases existed before a migration ledger was introduced.
 */
function ensureInitialSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_threads (
      thread_id TEXT PRIMARY KEY,
      channel TEXT,
      title TEXT NOT NULL DEFAULT '',
      title_source TEXT NOT NULL DEFAULT 'heuristic',
      summary TEXT NOT NULL DEFAULT '',
      summary_upto_seq INTEGER NOT NULL DEFAULT 0,
      summary_version INTEGER NOT NULL DEFAULT 0,
      summary_candidate TEXT,
      summary_candidate_upto_seq INTEGER,
      summary_status TEXT NOT NULL DEFAULT 'idle' CHECK (summary_status IN ('idle','running','ready','failed')),
      summary_last_error TEXT,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq),
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread_seq
      ON conversation_messages(thread_id, seq DESC);

    CREATE INDEX IF NOT EXISTS idx_conversation_threads_updated_at
      ON conversation_threads(updated_at_ms DESC);

    CREATE TABLE IF NOT EXISTS pending_mutations (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      client_channel TEXT,
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      effect TEXT NOT NULL,
      route_key TEXT,
      preview TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','executing','executed','failed','cancelled')),
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      executed_at_ms INTEGER,
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pending_mutations_thread_status
      ON pending_mutations(thread_id, status, expires_at_ms DESC);

    CREATE TABLE IF NOT EXISTS conversation_result_sets (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      source_action TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      focused_position INTEGER,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      context_json TEXT,
      FOREIGN KEY(thread_id) REFERENCES conversation_threads(thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_result_set_items (
      result_set_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position > 0),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      display_label TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY(result_set_id, position),
      FOREIGN KEY(result_set_id) REFERENCES conversation_result_sets(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_result_sets_active_thread
      ON conversation_result_sets(thread_id) WHERE active = 1;

    CREATE INDEX IF NOT EXISTS idx_conversation_result_sets_expiry
      ON conversation_result_sets(thread_id, expires_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_preference_profiles (
      profile_id TEXT PRIMARY KEY,
      type_weights_json TEXT NOT NULL DEFAULT '{}',
      tag_weights_json TEXT NOT NULL DEFAULT '{}',
      venue_weights_json TEXT NOT NULL DEFAULT '{}',
      daypart_weights_json TEXT NOT NULL DEFAULT '{}',
      weekday_weights_json TEXT NOT NULL DEFAULT '{}',
      price_affinity REAL NOT NULL DEFAULT 0,
      distance_affinity REAL NOT NULL DEFAULT 0,
      free_affinity REAL NOT NULL DEFAULT 0,
      indoor_outdoor_affinity REAL NOT NULL DEFAULT 0,
      explicit_exclusions_json TEXT NOT NULL DEFAULT '[]',
      proactive_enabled INTEGER NOT NULL DEFAULT 0 CHECK (proactive_enabled IN (0,1)),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS culture_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN (
        'explicit_like','explicit_dislike','save','selection','details','dismiss','query'
      )),
      strength REAL NOT NULL,
      created_at_ms INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_culture_feedback_profile_created
      ON culture_feedback(profile_id, created_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_culture_feedback_profile_entity
      ON culture_feedback(profile_id, entity_type, entity_id, created_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_saved_entities (
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      title TEXT NOT NULL,
      categories_json TEXT NOT NULL DEFAULT '[]',
      venue_json TEXT,
      occurrence_date TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      saved_at_ms INTEGER NOT NULL,
      PRIMARY KEY(profile_id, entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_culture_saved_profile_date
      ON culture_saved_entities(profile_id, saved_at_ms DESC);

    CREATE TABLE IF NOT EXISTS culture_proactive_notifications (
      profile_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reason TEXT NOT NULL,
      notified_at_ms INTEGER NOT NULL,
      PRIMARY KEY(profile_id, fingerprint)
    );

    CREATE INDEX IF NOT EXISTS idx_culture_proactive_profile_notified
      ON culture_proactive_notifications(profile_id, notified_at_ms DESC);
  `);

  if (!hasColumn(db, 'conversation_result_sets', 'context_json')) {
    db.exec('ALTER TABLE conversation_result_sets ADD COLUMN context_json TEXT;');
  }
  if (!hasColumn(db, 'conversation_result_set_items', 'metadata_json')) {
    db.exec('ALTER TABLE conversation_result_set_items ADD COLUMN metadata_json TEXT;');
  }
  if (!hasColumn(db, 'conversation_threads', 'channel')) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN channel TEXT;');
  }
  if (!hasColumn(db, 'conversation_threads', 'title')) {
    db.exec("ALTER TABLE conversation_threads ADD COLUMN title TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, 'conversation_threads', 'title_source')) {
    db.exec(
      "ALTER TABLE conversation_threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'heuristic';"
    );
  }
  if (!hasColumn(db, 'conversation_threads', 'last_response_time_ms')) {
    db.exec('ALTER TABLE conversation_threads ADD COLUMN last_response_time_ms INTEGER DEFAULT 0;');
  }
  if (!hasColumn(db, 'conversation_threads', 'conversation_window_expires_at_ms')) {
    db.exec(
      'ALTER TABLE conversation_threads ADD COLUMN conversation_window_expires_at_ms INTEGER DEFAULT 0;'
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_threads_channel_updated
      ON conversation_threads(channel, updated_at_ms DESC);
  `);
}

export function runConversationMigrations(db: Database.Database): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true }));
  if (currentVersion > CONVERSATION_SCHEMA_VERSION) {
    throw new Error(
      `conversation_database_newer_than_runtime:${currentVersion}>${CONVERSATION_SCHEMA_VERSION}`
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{
    version: number;
    checksum: string;
  }>;
  const applied = new Map(appliedRows.map((row) => [row.version, row.checksum]));
  if (applied.get(1) && applied.get(1) !== INITIAL_SCHEMA_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:1');
  if (applied.get(2) && applied.get(2) !== IDENTITY_SCHEMA_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:2');
  if (applied.get(3) && applied.get(3) !== AUTHORIZATION_POLICY_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:3');
  if (applied.get(4) && applied.get(4) !== USER_DATA_OWNERSHIP_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:4');
  if (applied.get(5) && applied.get(5) !== SERVICE_DATA_OWNERSHIP_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:5');
  if (applied.get(6) && applied.get(6) !== ADMIN_CONTROL_PLANE_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:6');
  if (applied.get(7) && applied.get(7) !== PERSONAL_INTEGRATIONS_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:7');
  if (applied.get(8) && applied.get(8) !== SIMPLE_HOME_ROLES_CHECKSUM)
    throw new Error('conversation_migration_checksum_mismatch:8');

  db.transaction(() => {
    ensureInitialSchema(db);
    if (!applied.has(1)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)'
      ).run(1, 'initial_conversation_schema', INITIAL_SCHEMA_CHECKSUM, Date.now());
    }
    ensureIdentitySchema(db);
    if (!applied.has(2))
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (2, ?, ?, ?)'
      ).run('identity_foundation', IDENTITY_SCHEMA_CHECKSUM, Date.now());
    ensureAuthorizationPolicy(db);
    if (!applied.has(3)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (3, ?, ?, ?)'
      ).run('authorization_policy', AUTHORIZATION_POLICY_CHECKSUM, Date.now());
    }
    ensureUserDataOwnershipSchema(db);
    if (!applied.has(4)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (4, ?, ?, ?)'
      ).run('user_data_ownership', USER_DATA_OWNERSHIP_CHECKSUM, Date.now());
    }
    ensureServiceDataOwnershipSchema(db);
    if (!applied.has(5)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (5, ?, ?, ?)'
      ).run('service_data_ownership', SERVICE_DATA_OWNERSHIP_CHECKSUM, Date.now());
    }
    ensureAdminControlPlaneSchema(db);
    if (!applied.has(6)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (6, ?, ?, ?)'
      ).run('admin_control_plane', ADMIN_CONTROL_PLANE_CHECKSUM, Date.now());
    }
    ensurePersonalIntegrationsSchema(db);
    if (!applied.has(7)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (7, ?, ?, ?)'
      ).run('personal_integrations', PERSONAL_INTEGRATIONS_CHECKSUM, Date.now());
    }
    ensureSimpleHomeRoles(db);
    if (!applied.has(8)) {
      db.prepare(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (8, ?, ?, ?)'
      ).run('simple_home_roles', SIMPLE_HOME_ROLES_CHECKSUM, Date.now());
    }
    db.pragma(`user_version = ${CONVERSATION_SCHEMA_VERSION}`);
  })();
}
