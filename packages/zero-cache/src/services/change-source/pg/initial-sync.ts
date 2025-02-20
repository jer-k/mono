import type {LogContext} from '@rocicorp/logger';
import postgres from 'postgres';
import {Database} from '../../../../../zqlite/src/db.js';
import {
  createIndexStatement,
  createTableStatement,
} from '../../../db/create.js';
import * as Mode from '../../../db/mode-enum.js';
import {
  mapPostgresToLite,
  mapPostgresToLiteIndex,
} from '../../../db/pg-to-lite.js';
import type {IndexSpec, PublishedTableSpec} from '../../../db/specs.js';
import {importSnapshot, TransactionPool} from '../../../db/transaction-pool.js';
import type {LexiVersion} from '../../../types/lexi-version.js';
import {liteValues} from '../../../types/lite.js';
import {liteTableName} from '../../../types/names.js';
import {pgClient, type PostgresDB} from '../../../types/pg.js';
import {id} from '../../../types/sql.js';
import {initChangeLog} from '../../replicator/schema/change-log.js';
import {
  initReplicationState,
  ZERO_VERSION_COLUMN_NAME,
} from '../../replicator/schema/replication-state.js';
import {toLexiVersion} from './lsn.js';
import {initShardSchema} from './schema/init.js';
import {getPublicationInfo, type PublicationInfo} from './schema/published.js';
import {
  getInternalShardConfig,
  setInitialSchema,
  validatePublications,
} from './schema/shard.js';
import type {ShardConfig} from './shard-config.js';

export type InitialSyncOptions = {
  tableCopyWorkers: number;
  rowBatchSize: number;
};

// https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS-MANIPULATION
const ALLOWED_SHARD_ID_CHARACTERS = /^[a-z0-9_]+$/;

export function replicationSlot(shardID: string): string {
  return `zero_${shardID}`;
}

export async function initialSync(
  lc: LogContext,
  shard: ShardConfig,
  tx: Database,
  upstreamURI: string,
  syncOptions: InitialSyncOptions,
) {
  if (!ALLOWED_SHARD_ID_CHARACTERS.test(shard.id)) {
    throw new Error(
      'A shard ID may only consist of lower-case letters, numbers, and the underscore character',
    );
  }
  const {tableCopyWorkers: numWorkers, rowBatchSize} = syncOptions;
  const upstreamDB = pgClient(lc, upstreamURI, {max: numWorkers});
  const replicationSession = pgClient(lc, upstreamURI, {
    ['fetch_types']: false, // Necessary for the streaming protocol
    connection: {replication: 'database'}, // https://www.postgresql.org/docs/current/protocol-replication.html
  });
  try {
    await checkUpstreamConfig(upstreamDB);

    // Kill the active_pid on the existing slot before altering publications,
    // as deleting a publication associated with an existing subscriber causes
    // weirdness; the active_pid becomes null and thus unable to be terminated.
    const slotName = replicationSlot(shard.id);
    const slots = await upstreamDB<{pid: string | null}[]>`
    SELECT pg_terminate_backend(active_pid), active_pid as pid
      FROM pg_replication_slots WHERE slot_name = ${slotName}`;
    if (slots.length > 0 && slots[0].pid !== null) {
      lc.info?.(`signaled subscriber ${slots[0].pid} to shut down`);
    }

    const {publications} = await ensurePublishedTables(lc, upstreamDB, shard);
    lc.info?.(`Upstream is setup with publications [${publications}]`);

    const {database, host} = upstreamDB.options;
    lc.info?.(`opening replication session to ${database}@${host}`);
    const {snapshot_name: snapshot, consistent_point: lsn} =
      await createReplicationSlot(
        lc,
        replicationSession,
        slotName,
        slots.length > 0,
      );
    const initialVersion = toLexiVersion(lsn);

    // Run up to MAX_WORKERS to copy of tables at the replication slot's snapshot.
    const copiers = startTableCopyWorkers(lc, upstreamDB, snapshot, numWorkers);
    let published: PublicationInfo;
    try {
      // Retrieve the published schema at the consistent_point.
      published = await copiers.processReadTask(db =>
        getPublicationInfo(db, publications),
      );
      // Note: If this throws, initial-sync is aborted.
      validatePublications(lc, shard.id, published);

      // Now that tables have been validated, kick off the copiers.
      const {tables, indexes} = published;
      createLiteTables(tx, tables);
      createLiteIndices(tx, indexes);
      await Promise.all(
        tables.map(table =>
          copiers.process(db =>
            copy(lc, table, db, tx, initialVersion, rowBatchSize).then(
              () => [],
            ),
          ),
        ),
      );
    } finally {
      copiers.setDone();
      await copiers.done();
    }
    await setInitialSchema(upstreamDB, shard.id, published);

    initReplicationState(tx, publications, initialVersion);
    initChangeLog(tx);
    lc.info?.(`Synced initial data from ${publications} up to ${lsn}`);
  } finally {
    await replicationSession.end();
    await upstreamDB.end();
  }
}

async function checkUpstreamConfig(upstreamDB: PostgresDB) {
  const {walLevel, version} = (
    await upstreamDB<{walLevel: string; version: number}[]>`
      SELECT current_setting('wal_level') as "walLevel", 
             current_setting('server_version_num') as "version";
  `
  )[0];

  if (walLevel !== 'logical') {
    throw new Error(
      `Postgres must be configured with "wal_level = logical" (currently: "${walLevel})`,
    );
  }
  if (version < 150000) {
    throw new Error(
      `Must be running Postgres 15 or higher (currently: "${version}")`,
    );
  }
}

async function ensurePublishedTables(
  lc: LogContext,
  upstreamDB: PostgresDB,
  shard: ShardConfig,
): Promise<{publications: string[]}> {
  const {database, host} = upstreamDB.options;
  lc.info?.(`Ensuring upstream PUBLICATION on ${database}@${host}`);

  await initShardSchema(lc, upstreamDB, shard);

  return getInternalShardConfig(upstreamDB, shard.id);
}

/* eslint-disable @typescript-eslint/naming-convention */
// Row returned by `CREATE_REPLICATION_SLOT`
type ReplicationSlot = {
  slot_name: string;
  consistent_point: string;
  snapshot_name: string;
  output_plugin: string;
};
/* eslint-enable @typescript-eslint/naming-convention */

// Note: The replication connection does not support the extended query protocol,
//       so all commands must be sent using sql.unsafe(). This is technically safe
//       because all placeholder values are under our control (i.e. "slotName").
async function createReplicationSlot(
  lc: LogContext,
  session: postgres.Sql,
  slotName: string,
  dropExisting: boolean,
): Promise<ReplicationSlot> {
  // Because a snapshot created by CREATE_REPLICATION_SLOT only lasts for the lifetime
  // of the replication session, if there is an existing slot, it must be deleted so that
  // the slot (and corresponding snapshot) can be created anew.
  //
  // This means that in order for initial data sync to succeed, it must fully complete
  // within the lifetime of a replication session. Note that this is same requirement
  // (and behavior) for Postgres-to-Postgres initial sync:
  // https://github.com/postgres/postgres/blob/5304fec4d8a141abe6f8f6f2a6862822ec1f3598/src/backend/replication/logical/tablesync.c#L1358
  if (dropExisting) {
    lc.info?.(`Dropping existing replication slot ${slotName}`);
    await session.unsafe(`DROP_REPLICATION_SLOT ${slotName} WAIT`);
  }
  const slot = (
    await session.unsafe<ReplicationSlot[]>(
      `CREATE_REPLICATION_SLOT "${slotName}" LOGICAL pgoutput`,
    )
  )[0];
  lc.info?.(`Created replication slot ${slotName}`, slot);
  return slot;
}

function startTableCopyWorkers(
  lc: LogContext,
  db: PostgresDB,
  snapshot: string,
  numWorkers: number,
): TransactionPool {
  const {init} = importSnapshot(snapshot);
  const tableCopiers = new TransactionPool(
    lc,
    Mode.READONLY,
    init,
    undefined,
    numWorkers,
  );
  tableCopiers.run(db);

  lc.info?.(`Started ${numWorkers} workers to copy tables`);
  return tableCopiers;
}

function createLiteTables(tx: Database, tables: PublishedTableSpec[]) {
  for (const t of tables) {
    tx.exec(createTableStatement(mapPostgresToLite(t)));
  }
}

function createLiteIndices(tx: Database, indices: IndexSpec[]) {
  for (const index of indices) {
    tx.exec(createIndexStatement(mapPostgresToLiteIndex(index)));
  }
}

async function copy(
  lc: LogContext,
  table: PublishedTableSpec,
  from: PostgresDB,
  to: Database,
  initialVersion: LexiVersion,
  rowBatchSize: number,
) {
  let totalRows = 0;
  const tableName = liteTableName(table);
  const selectColumns = Object.keys(table.columns)
    .map(c => id(c))
    .join(',');
  const insertColumns = [
    ...Object.keys(table.columns),
    ZERO_VERSION_COLUMN_NAME,
  ];
  const insertColumnList = insertColumns.map(c => id(c)).join(',');
  const insertStmt = to.prepare(
    `INSERT INTO "${tableName}" (${insertColumnList}) VALUES (${new Array(
      insertColumns.length,
    )
      .fill('?')
      .join(',')})`,
  );
  const filterConditions = Object.values(table.publications)
    .map(({rowFilter}) => rowFilter)
    .filter(f => !!f); // remove nulls
  const selectStmt =
    `SELECT ${selectColumns} FROM ${id(table.schema)}.${id(table.name)}` +
    (filterConditions.length === 0
      ? ''
      : ` WHERE ${filterConditions.join(' OR ')}`);

  lc.info?.(`Starting copy of ${tableName}:`, selectStmt);

  const cursor = from.unsafe(selectStmt).cursor(rowBatchSize);
  for await (const rows of cursor) {
    for (const row of rows) {
      insertStmt.run([...liteValues(row, table), initialVersion]);
    }
    totalRows += rows.length;
    lc.debug?.(`Copied ${totalRows} rows from ${table.schema}.${table.name}`);
  }
  lc.info?.(`Finished copying ${totalRows} rows into ${tableName}`);
}
