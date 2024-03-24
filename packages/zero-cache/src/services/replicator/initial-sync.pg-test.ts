import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import type postgres from 'postgres';
import {expectTables, initDB, testDBs} from '../../test/db.js';
import {createSilentLogContext} from '../../test/logger.js';
import {
  handoffPostgresReplication,
  replicationSlot,
  startPostgresReplication,
  waitForInitialDataSynchronization,
} from './initial-sync.js';
import {getPublicationInfo} from './tables/published.js';
import type {TableSpec} from './tables/specs.js';

const SUB = 'test_sync';
const REPLICA_ID = 'initial_sync_test_id';

const ZERO_CLIENTS_SPEC: TableSpec = {
  columns: {
    clientID: {
      characterMaximumLength: null,
      columnDefault: null,
      dataType: 'text',
      notNull: true,
    },
    lastMutationID: {
      characterMaximumLength: null,
      columnDefault: null,
      dataType: 'int8',
      notNull: false,
    },
  },
  name: 'clients',
  primaryKey: ['clientID'],
  schema: 'zero',
} as const;

describe('replicator/initial-sync', () => {
  type Case = {
    name: string;
    setupUpstreamQuery?: string;
    setupReplicaQuery?: string;
    published: Record<string, TableSpec>;
    upstream?: Record<string, object[]>;
    replicated: Record<string, object[]>;
    publications: string[];
  };

  const cases: Case[] = [
    {
      name: 'empty DB',
      published: {
        ['zero.clients']: ZERO_CLIENTS_SPEC,
      },
      replicated: {
        ['zero.clients']: [],
      },
      publications: ['zero_meta', 'zero_data'],
    },
    {
      name: 'replication slot already exists',
      setupUpstreamQuery: `
        SELECT * FROM pg_create_logical_replication_slot('${replicationSlot(
          REPLICA_ID,
        )}', 'pgoutput');
      `,
      published: {
        ['zero.clients']: ZERO_CLIENTS_SPEC,
      },
      replicated: {
        ['zero.clients']: [],
      },
      publications: ['zero_meta', 'zero_data'],
    },
    {
      name: 'publication already setup',
      setupUpstreamQuery: `
      CREATE SCHEMA zero;
      CREATE TABLE zero.clients (
       "clientID" TEXT PRIMARY KEY,
        "lastMutationID" BIGINT
      );
      CREATE PUBLICATION zero_meta FOR TABLES IN SCHEMA zero;
      CREATE PUBLICATION zero_data FOR ALL TABLES;;
      `,
      published: {
        ['zero.clients']: ZERO_CLIENTS_SPEC,
      },
      replicated: {
        ['zero.clients']: [],
      },
      publications: ['zero_meta', 'zero_data'],
    },
    {
      name: 'existing table, default publication',
      setupUpstreamQuery: `
        CREATE TABLE issues("issueID" INTEGER, "orgID" INTEGER, PRIMARY KEY ("orgID", "issueID"));
      `,
      published: {
        ['zero.clients']: ZERO_CLIENTS_SPEC,
        ['public.issues']: {
          columns: {
            issueID: {
              characterMaximumLength: null,
              columnDefault: null,
              dataType: 'int4',
              notNull: true,
            },
            orgID: {
              characterMaximumLength: null,
              columnDefault: null,
              dataType: 'int4',
              notNull: true,
            },
          },
          name: 'issues',
          primaryKey: ['orgID', 'issueID'],
          schema: 'public',
        },
      },
      upstream: {
        issues: [
          {issueID: 123, orgID: 456},
          {issueID: 321, orgID: 789},
        ],
      },
      replicated: {
        ['zero.clients']: [],
        issues: [
          {issueID: 123, orgID: 456, ['_0_version']: '00'},
          {issueID: 321, orgID: 789, ['_0_version']: '00'},
        ],
      },
      publications: ['zero_meta', 'zero_data'],
    },
    {
      name: 'existing partial publication',
      setupUpstreamQuery: `
        CREATE TABLE not_published("issueID" INTEGER, "orgID" INTEGER, PRIMARY KEY ("orgID", "issueID"));
        CREATE TABLE users("userID" INTEGER, password TEXT, handle TEXT, PRIMARY KEY ("userID"));
        CREATE PUBLICATION zero_custom FOR TABLE users ("userID", handle);
      `,
      published: {
        ['zero.clients']: ZERO_CLIENTS_SPEC,
        ['public.users']: {
          columns: {
            userID: {
              characterMaximumLength: null,
              columnDefault: null,
              dataType: 'int4',
              notNull: true,
            },
            // Note: password is not published
            handle: {
              characterMaximumLength: null,
              columnDefault: null,
              dataType: 'text',
              notNull: false,
            },
          },
          name: 'users',
          primaryKey: ['userID'],
          schema: 'public',
        },
      },
      upstream: {
        users: [
          {userID: 123, password: 'not-replicated', handle: '@zoot'},
          {userID: 456, password: 'super-secret', handle: '@bonk'},
        ],
      },
      replicated: {
        ['zero.clients']: [],
        users: [
          {userID: 123, handle: '@zoot', ['_0_version']: '00'},
          {userID: 456, handle: '@bonk', ['_0_version']: '00'},
        ],
      },
      publications: ['zero_meta', 'zero_custom'],
    },
  ];

  let upstream: postgres.Sql;
  let replica: postgres.Sql;

  beforeEach(async () => {
    upstream = await testDBs.create('initial_sync_upstream');
    replica = await testDBs.create('initial_sync_replica');
  });

  afterEach(async () => {
    // Technically done by the tested code, but this helps clean things up in the event of failures.
    await replica.begin(async tx => {
      const subs =
        await tx`SELECT subname FROM pg_subscription WHERE subname = ${SUB}`;
      if (subs.count > 0) {
        await tx.unsafe(`
        ALTER SUBSCRIPTION ${SUB} DISABLE;
        ALTER SUBSCRIPTION ${SUB} SET(slot_name=NONE);
        DROP SUBSCRIPTION IF EXISTS ${SUB};
      `);
      }
    });
    await upstream.begin(async tx => {
      const slots = await tx`
        SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${replicationSlot(
          REPLICA_ID,
        )}`;
      if (slots.count > 0) {
        await tx`
          SELECT pg_drop_replication_slot(${replicationSlot(REPLICA_ID)});`;
      }
    });
    await testDBs.drop(upstream, replica);
  }, 10000);

  for (const c of cases) {
    test(`startInitialDataSynchronization: ${c.name}`, async () => {
      await initDB(upstream, c.setupUpstreamQuery, c.upstream);
      await initDB(replica, c.setupReplicaQuery);

      const lc = createSilentLogContext();
      await replica.begin(tx =>
        startPostgresReplication(
          lc,
          REPLICA_ID,
          tx,
          'postgres:///initial_sync_upstream',
          SUB,
        ),
      );

      const published = await getPublicationInfo(upstream, 'zero_');
      expect(published.tables).toEqual(c.published);
      expect(published.publications.map(p => p.pubname)).toEqual(
        expect.arrayContaining(c.publications),
      );

      const synced = await getPublicationInfo(replica, 'zero_');
      expect(synced.tables).toMatchObject(c.published);
      expect(synced.publications.map(p => p.pubname)).toEqual(
        expect.arrayContaining(c.publications),
      );

      await waitForInitialDataSynchronization(
        lc,
        REPLICA_ID,
        replica,
        'postgres:///initial_sync_upstream',
        SUB,
      );

      await expectTables(replica, c.replicated);

      await replica.begin(tx =>
        handoffPostgresReplication(
          lc,
          REPLICA_ID,
          tx,
          'postgres:///initial_sync_upstream',
          SUB,
        ),
      );

      // Subscriptions should have been dropped.
      const subs =
        await replica`SELECT subname FROM pg_subscription WHERE subname = ${SUB}`;
      expect(subs).toEqual([]);

      // Slot should still exist.
      const slots =
        await upstream`SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${replicationSlot(
          REPLICA_ID,
        )}`.values();
      expect(slots[0]).toEqual([replicationSlot(REPLICA_ID)]);
    }, 10000);

    type InvalidUpstreamCase = {
      error: string;
      setupUpstreamQuery?: string;
      upstream?: Record<string, object[]>;
    };

    const invalidUpstreamCases: InvalidUpstreamCase[] = [
      {
        error: 'does not have a PRIMARY KEY',
        setupUpstreamQuery: `
        CREATE TABLE issues("issueID" INTEGER, "orgID" INTEGER);
      `,
      },
      {
        error: 'uses reserved column name _0_version',
        setupUpstreamQuery: `
        CREATE TABLE issues(
          "issueID" INTEGER PRIMARY KEY, 
          "orgID" INTEGER, 
          _0_version INTEGER);
      `,
      },
      {
        error: 'Schema _zero is reserved for internal use',
        setupUpstreamQuery: `
        CREATE SCHEMA _zero;
        CREATE TABLE _zero.is_not_allowed(
          "issueID" INTEGER PRIMARY KEY, 
          "orgID" INTEGER
        );
        `,
      },
    ];

    for (const c of invalidUpstreamCases) {
      test(`Invalid upstream: ${c.error}`, async () => {
        await initDB(upstream, c.setupUpstreamQuery, c.upstream);

        const result = await replica
          .begin(tx =>
            startPostgresReplication(
              createSilentLogContext(),
              REPLICA_ID,
              tx,
              'postgres:///initial_sync_upstream',
              SUB,
            ),
          )
          .catch(e => e);

        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toContain(c.error);
      });
    }
  }
});