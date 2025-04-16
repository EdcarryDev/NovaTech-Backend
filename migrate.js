const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { db, initializeDatabase, migrateFromSQLite } = require('./db-postgres');
const { promisify } = require('util');

// Helper function to promisify SQLite queries
function promisifyDb(db) {
    return {
        all: promisify(db.all).bind(db),
        get: promisify(db.get).bind(db),
        run: promisify(db.run).bind(db)
    };
}

async function migrate() {
    let sqliteDb;
    try {
        console.log('Starting migration to Render PostgreSQL database...');

        // Connect to SQLite database
        sqliteDb = new sqlite3.Database(path.join(__dirname, 'mikrotik.db'));
        const promisifiedDb = promisifyDb(sqliteDb);
        console.log('Connected to SQLite database');

        // Initialize PostgreSQL database
        console.log('Initializing PostgreSQL database structure...');
        await initializeDatabase();
        console.log('PostgreSQL database structure initialized');

        // Get table counts for progress tracking
        const routerCount = await promisifiedDb.get('SELECT COUNT(*) as count FROM routers');
        const userCount = await promisifiedDb.get('SELECT COUNT(*) as count FROM hotspot_users');
        const profileCount = await promisifiedDb.get('SELECT COUNT(*) as count FROM hotspot_profiles');
        const transactionCount = await promisifiedDb.get('SELECT COUNT(*) as count FROM financial_transactions');

        console.log(`
Found records to migrate:
- Routers: ${routerCount.count}
- Hotspot Users: ${userCount.count}
- Hotspot Profiles: ${profileCount.count}
- Financial Transactions: ${transactionCount.count}
`);

        // Migrate data
        console.log('Starting data migration...');
        await migrateFromSQLite(promisifiedDb);

        console.log('Migration completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    } finally {
        if (sqliteDb) {
            sqliteDb.close();
        }
    }
}

migrate(); 