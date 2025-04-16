require('dotenv').config();
const pgp = require('pg-promise')();

// PostgreSQL connection configuration for Render
const cn = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Render's self-signed certificate
    },
    max: 30 // Maximum number of clients in the pool
};

const db = pgp(cn);

// Test the connection
async function testConnection() {
    try {
        const connection = await db.connect();
        console.log('Successfully connected to Render PostgreSQL database');
        connection.done(); // Release the connection
    } catch (error) {
        console.error('Error connecting to the database:', error);
        throw error;
    }
}

// Initialize database tables
async function initializeDatabase() {
    try {
        await testConnection(); // Test connection before proceeding
        
        await db.tx(async t => {
            // Create routers table
            await t.none(`
                CREATE TABLE IF NOT EXISTS routers (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    host TEXT NOT NULL,
                    username TEXT NOT NULL,
                    password TEXT NOT NULL,
                    hotspot_name TEXT,
                    dns_name TEXT,
                    currency TEXT,
                    session_timeout TEXT,
                    live_report BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_connected TIMESTAMP
                )
            `);

            // Create hotspot_users table
            await t.none(`
                CREATE TABLE IF NOT EXISTS hotspot_users (
                    id SERIAL PRIMARY KEY,
                    router_id INTEGER NOT NULL REFERENCES routers(id),
                    username TEXT NOT NULL,
                    password TEXT,
                    profile TEXT,
                    server TEXT,
                    mac_address TEXT,
                    last_uptime TEXT,
                    last_bytes_in TEXT,
                    last_bytes_out TEXT,
                    comment TEXT,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(router_id, username)
                )
            `);

            // Create hotspot_profiles table
            await t.none(`
                CREATE TABLE IF NOT EXISTS hotspot_profiles (
                    id SERIAL PRIMARY KEY,
                    router_id INTEGER NOT NULL REFERENCES routers(id),
                    name TEXT NOT NULL,
                    shared_users TEXT NOT NULL,
                    rate_limit TEXT NOT NULL,
                    expire_mode TEXT NOT NULL,
                    validity TEXT NOT NULL,
                    price TEXT NOT NULL,
                    selling_price TEXT NOT NULL,
                    user_lock TEXT NOT NULL,
                    server_lock TEXT NOT NULL,
                    session_timeout TEXT,
                    idle_timeout TEXT,
                    keepalive_timeout TEXT,
                    status_autorefresh TEXT,
                    mac_cookie_timeout TEXT,
                    mikrotik_profile INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(router_id, name)
                )
            `);

            // Create financial_transactions table
            await t.none(`
                CREATE TABLE IF NOT EXISTS financial_transactions (
                    id SERIAL PRIMARY KEY,
                    router_id INTEGER NOT NULL REFERENCES routers(id),
                    voucher_name TEXT NOT NULL,
                    batch_name TEXT,
                    profile TEXT NOT NULL,
                    amount DECIMAL(10,2) NOT NULL,
                    currency TEXT NOT NULL,
                    transaction_date TIMESTAMP NOT NULL,
                    transaction_type TEXT NOT NULL,
                    ip_address TEXT,
                    mac_address TEXT,
                    login_count INTEGER DEFAULT 1,
                    usage_duration INTEGER,
                    status TEXT DEFAULT 'COMPLETED',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create index for faster queries
            await t.none(`
                CREATE INDEX IF NOT EXISTS idx_financial_transactions_router 
                ON financial_transactions(router_id, transaction_date)
            `);
        });

        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    }
}

// Migration function to transfer data from SQLite to PostgreSQL
async function migrateFromSQLite(sqliteDb) {
    try {
        await db.tx(async t => {
            // Migrate routers
            const routers = await sqliteDb.all('SELECT * FROM routers');
            console.log('Migrating routers:', routers);
            for (const router of routers) {
                await t.none(`
                    INSERT INTO routers(id, name, host, username, password, hotspot_name, dns_name, currency, session_timeout, live_report, created_at, last_connected)
                    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::integer::boolean, $11, $12)
                    ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    host = EXCLUDED.host,
                    username = EXCLUDED.username,
                    password = EXCLUDED.password,
                    hotspot_name = EXCLUDED.hotspot_name,
                    dns_name = EXCLUDED.dns_name,
                    currency = EXCLUDED.currency,
                    session_timeout = EXCLUDED.session_timeout,
                    live_report = EXCLUDED.live_report,
                    created_at = EXCLUDED.created_at,
                    last_connected = EXCLUDED.last_connected
                `, [
                    router.id,
                    router.name,
                    router.host,
                    router.user, // Note: mapping from 'user' to 'username'
                    router.password,
                    router.hotspot_name,
                    router.dns_name,
                    router.currency,
                    router.session_timeout,
                    router.live_report,
                    router.created_at,
                    router.last_connected
                ]);
            }
            console.log('Routers migration completed');

            // Migrate hotspot users
            const hotspotUsers = await sqliteDb.all('SELECT * FROM hotspot_users');
            console.log('Migrating hotspot users:', hotspotUsers.length);
            for (const user of hotspotUsers) {
                await t.none(`
                    INSERT INTO hotspot_users(
                        id, router_id, username, password, profile, server, mac_address,
                        last_uptime, last_bytes_in, last_bytes_out, comment, last_seen
                    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (router_id, username) DO UPDATE SET
                    password = EXCLUDED.password,
                    profile = EXCLUDED.profile,
                    server = EXCLUDED.server,
                    mac_address = EXCLUDED.mac_address,
                    last_uptime = EXCLUDED.last_uptime,
                    last_bytes_in = EXCLUDED.last_bytes_in,
                    last_bytes_out = EXCLUDED.last_bytes_out,
                    comment = EXCLUDED.comment,
                    last_seen = EXCLUDED.last_seen
                `, [
                    user.id,
                    user.router_id,
                    user.username,
                    user.password,
                    user.profile,
                    user.server,
                    user.mac_address,
                    user.last_uptime,
                    user.last_bytes_in,
                    user.last_bytes_out,
                    user.comment,
                    user.last_seen
                ]);
            }
            console.log('Hotspot users migration completed');

            // Migrate hotspot profiles
            const profiles = await sqliteDb.all('SELECT * FROM hotspot_profiles');
            console.log('Migrating hotspot profiles:', profiles.length);
            for (const profile of profiles) {
                // Get the first router's ID if profile.router_id is null
                const routerId = profile.router_id || routers[0]?.id;
                if (!routerId) {
                    console.log('Skipping profile due to no available router:', profile.name);
                    continue;
                }

                await t.none(`
                    INSERT INTO hotspot_profiles(
                        id, router_id, name, shared_users, rate_limit, expire_mode,
                        validity, price, selling_price, user_lock, server_lock,
                        session_timeout, idle_timeout, keepalive_timeout,
                        status_autorefresh, mac_cookie_timeout, mikrotik_profile,
                        created_at, updated_at
                    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                    ON CONFLICT (router_id, name) DO UPDATE SET
                    shared_users = EXCLUDED.shared_users,
                    rate_limit = EXCLUDED.rate_limit,
                    expire_mode = EXCLUDED.expire_mode,
                    validity = EXCLUDED.validity,
                    price = EXCLUDED.price,
                    selling_price = EXCLUDED.selling_price,
                    user_lock = EXCLUDED.user_lock,
                    server_lock = EXCLUDED.server_lock,
                    session_timeout = EXCLUDED.session_timeout,
                    idle_timeout = EXCLUDED.idle_timeout,
                    keepalive_timeout = EXCLUDED.keepalive_timeout,
                    status_autorefresh = EXCLUDED.status_autorefresh,
                    mac_cookie_timeout = EXCLUDED.mac_cookie_timeout,
                    mikrotik_profile = EXCLUDED.mikrotik_profile,
                    updated_at = CURRENT_TIMESTAMP
                `, [
                    profile.id,
                    routerId, // Use the determined router_id instead of profile.router_id
                    profile.name,
                    profile.shared_users,
                    profile.rate_limit,
                    profile.expire_mode,
                    profile.validity,
                    profile.price,
                    profile.selling_price,
                    profile.user_lock,
                    profile.server_lock,
                    profile.session_timeout,
                    profile.idle_timeout,
                    profile.keepalive_timeout,
                    profile.status_autorefresh,
                    profile.mac_cookie_timeout,
                    profile.mikrotik_profile,
                    profile.created_at,
                    profile.updated_at
                ]);
            }
            console.log('Hotspot profiles migration completed');

            // Migrate financial transactions
            const transactions = await sqliteDb.all('SELECT * FROM financial_transactions');
            console.log('Migrating financial transactions:', transactions.length);
            for (const transaction of transactions) {
                await t.none(`
                    INSERT INTO financial_transactions(
                        id, router_id, voucher_name, batch_name, profile,
                        amount, currency, transaction_date, transaction_type,
                        ip_address, mac_address, login_count, usage_duration,
                        status, created_at
                    ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `, [
                    transaction.id,
                    transaction.router_id,
                    transaction.voucher_name,
                    transaction.batch_name,
                    transaction.profile,
                    transaction.amount,
                    transaction.currency,
                    transaction.transaction_date,
                    transaction.transaction_type,
                    transaction.ip_address,
                    transaction.mac_address,
                    transaction.login_count,
                    transaction.usage_duration,
                    transaction.status,
                    transaction.created_at
                ]);
            }
            console.log('Financial transactions migration completed');
        });

        console.log('Migration completed successfully');
    } catch (error) {
        console.error('Error during migration:', error);
        throw error;
    }
}

// // Get router by ID
// function getRouterById(id) {
//     return db.oneOrNone('SELECT * FROM routers WHERE id = $1', [id]);
// }

// Add all the necessary database functions
const dbFunctions = {
    // Router functions
    getRouterById: async (id) => {
        return db.oneOrNone('SELECT * FROM routers WHERE id = $1', [id]);
    },

    addRouter: async (router) => {
        const { name, host, user, password, hotspotName, dnsName, currency, sessionTimeout, liveReport } = router;
        return db.one(
            `INSERT INTO routers (name, host, username, password, hotspot_name, dns_name, currency, session_timeout, live_report)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [name, host, user, password, hotspotName, dnsName, currency, sessionTimeout, liveReport]
        );
    },

    getAllRouters: async () => {
        return db.any('SELECT * FROM routers');
    },

    updateRouter: async (id, router) => {
        const { name, host, user, password, hotspotName, dnsName, currency, sessionTimeout, liveReport } = router;
        return db.oneOrNone(
            `UPDATE routers 
             SET name = $1, host = $2, username = $3, password = $4, 
                 hotspot_name = $5, dns_name = $6, currency = $7, 
                 session_timeout = $8, live_report = $9
             WHERE id = $10
             RETURNING *`,
            [name, host, user, password, hotspotName, dnsName, currency, sessionTimeout, liveReport, id]
        );
    },

    deleteRouter: async (id) => {
        return db.oneOrNone('DELETE FROM routers WHERE id = $1 RETURNING id', [id]);
    },

    updateLastConnected: async (id) => {
        return db.oneOrNone(
            'UPDATE routers SET last_connected = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id',
            [id]
        );
    },

    getRouterByHost: async (host) => {
        return db.oneOrNone('SELECT * FROM routers WHERE host = $1', [host]);
    },

    getRouterByHostAndName: async (host, name) => {
        return db.oneOrNone('SELECT * FROM routers WHERE host = $1 AND name = $2', [host, name]);
    },

    // Hotspot user functions
    updateHotspotUser: async (routerId, userData) => {
        return db.one(
            `INSERT INTO hotspot_users (
                router_id, username, profile, server, mac_address,
                last_uptime, last_bytes_in, last_bytes_out, comment,
                last_seen
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            ON CONFLICT(router_id, username) DO UPDATE SET
                profile = EXCLUDED.profile,
                server = EXCLUDED.server,
                mac_address = EXCLUDED.mac_address,
                last_uptime = EXCLUDED.last_uptime,
                last_bytes_in = EXCLUDED.last_bytes_in,
                last_bytes_out = EXCLUDED.last_bytes_out,
                comment = EXCLUDED.comment,
                last_seen = CURRENT_TIMESTAMP
            RETURNING id`,
            [
                routerId,
                userData.Name,
                userData.Profile,
                userData.Server,
                userData.MacAddress,
                userData.Uptime,
                userData.BytesIn,
                userData.BytesOut,
                userData.Comment
            ]
        );
    },

    // Function to get all hotspot profiles
    getAllHotspotProfiles: async () => {
        return db.any('SELECT * FROM hotspot_profiles');
    },

    // Function to delete hotspot profile
    deleteHotspotProfile: async (routerId, name) => {
        return db.oneOrNone('DELETE FROM hotspot_profiles WHERE router_id = $1 AND name = $2 RETURNING id', [routerId, name]);
    },

    // Function to insert or update a hotspot profile
    upsertHotspotProfile: async (profile) => {
        return db.oneOrNone(
            `INSERT INTO hotspot_profiles (
                router_id, name, shared_users, rate_limit, expire_mode,
                validity, price, selling_price, user_lock, server_lock,
                session_timeout, idle_timeout, keepalive_timeout,
                status_autorefresh, mac_cookie_timeout, mikrotik_profile,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            ON CONFLICT (router_id, name) DO UPDATE SET
                shared_users = EXCLUDED.shared_users,
                rate_limit = EXCLUDED.rate_limit,
                expire_mode = EXCLUDED.expire_mode,
                validity = EXCLUDED.validity,
                price = EXCLUDED.price,
                selling_price = EXCLUDED.selling_price,
                user_lock = EXCLUDED.user_lock,
                server_lock = EXCLUDED.server_lock, 
                session_timeout = EXCLUDED.session_timeout,
                idle_timeout = EXCLUDED.idle_timeout,
                keepalive_timeout = EXCLUDED.keepalive_timeout,
                status_autorefresh = EXCLUDED.status_autorefresh,
                mac_cookie_timeout = EXCLUDED.mac_cookie_timeout,
                mikrotik_profile = EXCLUDED.mikrotik_profile,   
                updated_at = CURRENT_TIMESTAMP
            RETURNING id`,
            [
                profile.router_id,
                profile.name,
                profile.shared_users,   
                profile.rate_limit,
                profile.expire_mode,
                profile.validity,
                profile.price,
                profile.selling_price,
                profile.user_lock,  
                profile.server_lock,
                profile.session_timeout,
                profile.idle_timeout,
                profile.keepalive_timeout,
                profile.status_autorefresh,
                profile.mac_cookie_timeout, 
                profile.mikrotik_profile,
                profile.created_at,
                profile.updated_at
            ]
        );
    }, 

    getHotspotProfile: async (routerId, profileName) => {
        return db.oneOrNone('SELECT * FROM hotspot_profiles WHERE router_id = $1 AND name = $2', [routerId, profileName]);
    },

    getStoredUserData: async (routerId, username) => {
        return db.oneOrNone(
            'SELECT * FROM hotspot_users WHERE router_id = $1 AND username = $2',
            [routerId, username]
        );
    },

    getAllStoredUsers: async (routerId) => {
        return db.any(
            'SELECT * FROM hotspot_users WHERE router_id = $1 ORDER BY last_seen DESC',
            [routerId]
        );
    },

    // Voucher and transaction functions
    clearVoucherRecords: async (routerId) => {
        return db.none('DELETE FROM hotspot_users WHERE router_id = $1', [routerId]);
    },

    storeFinancialTransaction: async (transaction) => {
        const {
            routerId,
            voucherName,
            batchName,
            profile,
            amount,
            currency,
            transactionDate,
            transactionType = 'VOUCHER_USAGE',
            ipAddress,
            macAddress,
            loginCount,
            usageDuration,
            status = 'COMPLETED'
        } = transaction;

        return db.one(
            `INSERT INTO financial_transactions (
                router_id, voucher_name, batch_name, profile, 
                amount, currency, transaction_date, transaction_type,
                ip_address, mac_address, login_count, usage_duration, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *`,
            [
                routerId,
                voucherName,
                batchName,
                profile,
                amount,
                currency,
                transactionDate,
                transactionType,
                ipAddress,
                macAddress,
                loginCount,
                usageDuration,
                status
            ]
        );
    },

    getRouterFinancialTransactions: async (routerId, startDate = null, endDate = null) => {
        const params = [routerId];
        let query = 'SELECT * FROM financial_transactions WHERE router_id = $1';
        
        if (startDate) {
            query += ' AND transaction_date >= $2';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND transaction_date <= $' + (params.length + 1);
            params.push(endDate);
        }
        
        query += ' ORDER BY transaction_date DESC';
        return db.any(query, params);
    },

    getBatchFinancialTransactions: async (routerId, batchName) => {
        return db.any(
            `SELECT * FROM financial_transactions 
             WHERE router_id = $1 AND batch_name = $2
             ORDER BY transaction_date DESC`,
            [routerId, batchName]
        );
    },

    getFinancialSummary: async (routerId, startDate = null, endDate = null) => {
        const params = [routerId];
        let query = `
            SELECT 
                COUNT(*) as total_transactions,
                SUM(amount) as total_revenue,
                currency,
                COUNT(DISTINCT batch_name) as batch_count,
                COUNT(DISTINCT profile) as profile_count,
                AVG(amount) as average_transaction,
                AVG(login_count) as average_logins
            FROM financial_transactions 
            WHERE router_id = $1
        `;
        
        if (startDate) {
            query += ' AND transaction_date >= $2';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND transaction_date <= $' + (params.length + 1);
            params.push(endDate);
        }
        
        query += ' GROUP BY currency';
        return db.oneOrNone(query, params);
    }
};

// Add all functions to module.exports
module.exports = {
    db,
    initializeDatabase,
    migrateFromSQLite,
    ...dbFunctions
}; 