import Database from 'better-sqlite3';
import { DB_PATH } from '../../src/core/config.js';
import { maintainDatabase } from '../../src/core/db-maintenance.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw db — explicit SQLite maintenance
  Usage: jaw db maintain
  maintain    Run WAL checkpoint then VACUUM and print page statistics.
`);

const subcommand = process.argv[3];
if (subcommand !== 'maintain') {
    console.error('Usage: jaw db maintain');
    process.exitCode = 1;
} else {
    const database = new Database(DB_PATH);
    database.pragma('busy_timeout = 5000');
    try {
        const result = maintainDatabase(database);
        console.log(`[db] before: page_count=${result.before.pageCount} freelist_count=${result.before.freelistCount}`);
        console.log(`[db] after: page_count=${result.after.pageCount} freelist_count=${result.after.freelistCount}`);
    } catch (error) {
        console.error(`[db] maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    } finally {
        database.close();
    }
}
