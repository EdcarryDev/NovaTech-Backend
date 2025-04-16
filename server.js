const express = require('express');
const cors = require('cors');
const RosApi = require('node-routeros').RouterOSAPI;
const { 
    db, 
    initializeDatabase,
    getRouterById,
    updateHotspotUser,
    getAllHotspotProfiles,
    deleteHotspotProfile,
    upsertHotspotProfile,
    getHotspotProfile,
    getAllStoredUsers
} = require('./db-postgres');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3001;

// Add at the top of the file, after the imports
const isDevelopment = process.env.NODE_ENV === 'development';

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database on server start
initializeDatabase().catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Store active connections and connection logs
const connections = new Map();
const connectionLogs = new Map();

// Helper function to safely stringify details
function safeStringifyDetails(details) {
    if (!details) return null;
    try {
        // First stringify to handle complex objects
        const stringified = JSON.stringify(details);
        // If the result is too long, truncate the original object
        if (stringified.length > 1000) {
            return JSON.stringify({
                truncated: true,
                message: "Details too large, showing partial data",
                summary: stringified.substring(0, 500) + "..."
            });
        }
        return stringified;
    } catch (error) {
        return JSON.stringify({
            error: "Could not serialize details",
            message: error.message
        });
    }
}

// Helper function to create a log entry
function createLogEntry(connectionId, description, type = 'info', details = null) {
    const now = new Date();
    const timestamp = now.toISOString();
    const timeStr = now.toLocaleTimeString();
    
    const logEntry = {
        time: timeStr,
        timestamp: timestamp,
        type: type,
        description: description,
        details: safeStringifyDetails(details)
    };
    
    // Initialize logs array for this connection if it doesn't exist
    if (!connectionLogs.has(connectionId)) {
        connectionLogs.set(connectionId, []);
    }
    
    // Add log to the connection's logs
    const logs = connectionLogs.get(connectionId);
    logs.unshift(logEntry); // Add to the beginning for reverse chronological order
    
    // Limit log size to prevent memory issues (keep last 100 entries)
    if (logs.length > 100) {
        logs.pop();
    }
    
    // Also log to console
    console.log(`[${timeStr}] [${connectionId}] [${type}] ${description}`);
    
    return logEntry;
}

// Helper function to format bitrate with appropriate units (bps, Kbps, Mbps, Gbps)
function formatBitrate(bps) {
    if (bps < 1000) {
        return `${bps} bps`;
    } else if (bps < 1000000) {
        return `${(bps / 1000).toFixed(2)} Kbps`;
    } else if (bps < 1000000000) {
        return `${(bps / 1000000).toFixed(2)} Mbps`;
    } else {
        return `${(bps / 1000000000).toFixed(2)} Gbps`;
    }
}

// Helper function to format traffic data
function formatTrafficData(trafficData, timestamp) {
    return {
        time: new Date(timestamp).toLocaleTimeString(),
        txBytes: trafficData['tx'] ? Math.floor(parseInt(trafficData['tx']) / 8) : 0,
        txFormatted: formatBitrate(parseInt(trafficData['tx'] || 0)),
        rxBytes: trafficData['rx'] ? Math.floor(parseInt(trafficData['rx']) / 8) : 0,
        rxFormatted: formatBitrate(parseInt(trafficData['rx'] || 0))
    };
}

// IMPORTANT: Middleware for logging API requests for connected routers
// This must come before any routes are defined
app.use((req, res, next) => {
    // Extract the connectionId from the URL if it exists
    const match = req.url.match(/\/api\/router\/([^\/]+)/);
    if (match && match[1] && connections.has(match[1])) {
        const connectionId = match[1];
        
        // Save the original send function
        const originalSend = res.send;
        
        // Override the send function
        res.send = function(body) {
            // Create a log entry for this API request
            try {
                const responseData = body ? JSON.parse(body) : {};
                const logType = res.statusCode >= 400 ? 'error' : 'info';
                
                createLogEntry(
                    connectionId,
                    `API Request: ${req.method} ${req.url}`,
                    logType,
                    {
                        method: req.method,
                        url: req.url,
                        statusCode: res.statusCode,
                        body: req.body,
                        response: responseData,
                        responseTime: Date.now() - req._startTime
                    }
                );
            } catch (error) {
                console.error('Error logging API request:', error);
            }
            
            // Call the original send function
            return originalSend.apply(this, arguments);
        };
        
        // Record start time
        req._startTime = Date.now();
    }
    
    next();
});

// Router connection endpoints
app.post('/api/router/connect', async (req, res) => {
    try {
        const { name, host, user, password, hotspotName, dnsName, currency, sessionTimeout, liveReport } = req.body;

        // Only host, user, and password are required for initial connection
        if (!host || !user || !password) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: host, user, or password'
            });
        }

        // Check if router exists in database using direct query
        const existingRouter = await db.oneOrNone(
            'SELECT * FROM routers WHERE host = $1 AND name = $2',
            [host, name]
        );

        const connection = new RosApi({
            host,
            user,
            password,
            port: 8728,
            timeout: 15000,
            keepalive: true
        });

        try {
            // Wrap connection in a timeout promise
            const connectWithTimeout = new Promise(async (resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    connection.close().catch(() => {});
                    reject(new Error('Connection timed out after 15 seconds'));
                }, 15000);

                try {
                    await connection.connect();
                    clearTimeout(timeoutId);
                    resolve();
                } catch (error) {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            });

            await connectWithTimeout;
            
            let savedRouter;
            let connectionId;

            if (existingRouter) {
                // Router exists, use existing record and update timestamp
                savedRouter = existingRouter;
                connectionId = savedRouter.id.toString();
                await db.none(
                    'UPDATE routers SET last_connected = CURRENT_TIMESTAMP WHERE id = $1',
                    [savedRouter.id]
                );
            } else {
                // Save new router to database with optional fields
                savedRouter = await db.one(
                    `INSERT INTO routers (
                        name, host, username, password, hotspot_name, 
                        dns_name, currency, session_timeout, live_report
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING *`,
                    [
                        name,
                        host,
                        user,
                        password,
                        hotspotName || '',
                        dnsName || '',
                        currency || '',
                        sessionTimeout || '',
                        liveReport !== undefined ? liveReport : true
                    ]
                );
                connectionId = savedRouter.id.toString();
            }
            
            connections.set(connectionId, connection);
            
            // Create first log entry for this connection
            createLogEntry(
                connectionId, 
                `Router '${savedRouter.name}' connected successfully`, 
                'success',
                { host, user, router: savedRouter.name }
            );

            // Set up error handler for the connection
            connection.on('error', async (err) => {
                createLogEntry(
                    connectionId,
                    `Connection error: ${err.message}`,
                    'error',
                    { error: err.message }
                );
                console.error(`Connection error for router ${connectionId}:`, err);
                connections.delete(connectionId);
            });

            connection.on('timeout', async () => {
                createLogEntry(
                    connectionId,
                    'Connection timeout',
                    'error',
                    { reason: 'timeout' }
                );
                console.error(`Connection timeout for router ${connectionId}`);
                connections.delete(connectionId);
            });
            
            res.json({
                success: true,
                message: 'Connected successfully',
                connectionId,
                routerInfo: savedRouter
            });
        } catch (error) {
            // Ensure connection is closed on error
            try {
                await connection.close();
            } catch {} // Ignore close errors

            // Log the connection failure
            console.error(`Connection failed: ${error.message}`);
            
            res.status(400).json({
                success: false,
                message: 'Connection failed',
                error: error.message
            });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// Disconnect router endpoint
app.post('/api/router/disconnect/:connectionId', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found'
            });
        }

        await connection.close();
        connections.delete(connectionId);
        
        // Create log entry for disconnection
        createLogEntry(
            connectionId,
            'Router disconnected successfully',
            'info',
            { reason: 'user_request' }
        );
        
        res.json({
            success: true,
            message: 'Disconnected successfully'
        });
    } catch (error) {
        // Log the error
        createLogEntry(
            req.params.connectionId,
            `Disconnect error: ${error.message}`,
            'error',
            { error: error.message }
        );
        
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// Router management endpoints
app.get('/api/routers', async (req, res) => {
    try {
        const routers = await db.any('SELECT * FROM routers');
        res.json({ success: true, routers });
    } catch (error) {
        console.error('Error getting routers:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/routers/:id', async (req, res) => {
    try {
        const router = await db.oneOrNone('SELECT * FROM routers WHERE id = $1', [req.params.id]);
        if (!router) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }
        res.json({ success: true, router });
    } catch (error) {
        console.error('Error getting router:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/routers/:id', async (req, res) => {
    try {
        const router = await db.oneOrNone(`
            UPDATE routers 
            SET name = $1, host = $2, username = $3, password = $4, 
                hotspot_name = $5, dns_name = $6, currency = $7, 
                session_timeout = $8, live_report = $9
            WHERE id = $10
            RETURNING *
        `, [
            req.body.name,
            req.body.host,
            req.body.user,
            req.body.password,
            req.body.hotspotName,
            req.body.dnsName,
            req.body.currency,
            req.body.sessionTimeout,
            req.body.liveReport,
            req.params.id
        ]);

        if (!router) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }
        res.json({ success: true, router });
    } catch (error) {
        console.error('Error updating router:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/routers/:id', async (req, res) => {
    try {
        const result = await db.result('DELETE FROM routers WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }
        res.json({ success: true, message: 'Router deleted successfully' });
    } catch (error) {
        console.error('Error deleting router:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update last connected timestamp
app.post('/api/routers/:id/update-connection', async (req, res) => {
    try {
        const result = await db.oneOrNone(`
            UPDATE routers 
            SET last_connected = CURRENT_TIMESTAMP 
            WHERE id = $1
            RETURNING *
        `, [req.params.id]);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Router not found' });
        }
        res.json({ success: true, router: result });
    } catch (error) {
        console.error('Error updating last connected:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// NEW ENDPOINT: Get total active WiFi users
app.get('/api/router/:connectionId/active-users', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }
        
        // Get router info to find the hotspot name
        const router = await getRouterById(connectionId);
        
        // Query active hotspot users
        // If hotspotName is defined in the router settings, we'll use it
        // Otherwise we'll get all hotspot users regardless of interface
        const command = '/ip/hotspot/active/print';
        const activeUsers = await connection.write(command);
        
        // If hotspotName is set and not empty, filter by interface
        let filteredUsers = activeUsers;
        if (router && router.hotspotName) {
            filteredUsers = activeUsers.filter(user => 
                user.server && user.server === router.hotspotName
            );
        }

        // Format the user data
        const formattedUsers = filteredUsers.map(user => ({
            server: user.server || 'all',
            user: user.user || '',
            address: user.address || '',
            macAddress: user['mac-address'] || '',
            uptime: user.uptime || '00:00:00',
            timeLeft: user['session-time-left'] || 'unlimited',
            bytesIn: formatBytes(parseInt(user['bytes-in'] || 0)),
            bytesOut: formatBytes(parseInt(user['bytes-out'] || 0)),
            loginBy: user['login-by'] || '',
            status: user.status || 'active',
            idleTime: user['idle-time'] || '00:00:00',
            comment: user.comment || ''
        }));
        
        res.json({
            success: true,
            data: {
                total: formattedUsers.length,
                users: formattedUsers
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get router resources (CPU, Memory, Disk)
app.get('/api/router/:connectionId/resources', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get CPU information
        const cpuInfo = await connection.write('/system/resource/cpu/print');
        
        // Get system resources
        const sysResources = await connection.write('/system/resource/print');
        
        // Process CPU load - average all cores 
        const totalCpuLoad = cpuInfo.reduce((sum, core) => sum + parseInt(core.load), 0);
        const avgCpuLoad = cpuInfo.length > 0 ? totalCpuLoad / cpuInfo.length : 0;
        const cpuLoadPercentage = avgCpuLoad.toFixed(1);
        
        // Format memory usage
        const totalMemory = parseFloat(sysResources[0]['total-memory'] || 0) / (1024 * 1024);
        const freeMemory = parseFloat(sysResources[0]['free-memory'] || 0) / (1024 * 1024);
        const usedMemory = totalMemory - freeMemory;
        
        // Format disk usage
        const totalHdd = parseFloat(sysResources[0]['total-hdd-space'] || 0) / (1024 * 1024);
        const freeHdd = parseFloat(sysResources[0]['free-hdd-space'] || 0) / (1024 * 1024);
        const usedHdd = totalHdd - freeHdd;
        
        res.json({
            success: true,
            data: {
                cpu: {
                    loadPercentage: cpuLoadPercentage,
                    frequencyMHz: sysResources[0]['cpu-frequency'] || '600',
                    cores: cpuInfo.length,
                    model: sysResources[0]['cpu'] || 'Unknown'
                },
                memory: {
                    total: totalMemory.toFixed(2),
                    used: usedMemory.toFixed(2),
                    free: freeMemory.toFixed(2),
                    usedPercentage: ((usedMemory / totalMemory) * 100).toFixed(1)
                },
                disk: {
                    total: totalHdd.toFixed(2),
                    used: usedHdd.toFixed(2),
                    free: freeHdd.toFixed(2),
                    usedPercentage: ((usedHdd / totalHdd) * 100).toFixed(1)
                },
                uptime: sysResources[0].uptime || 'Unknown',
                version: sysResources[0].version || 'Unknown',
                boardName: sysResources[0]['board-name'] || 'Unknown'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get system information
app.get('/api/router/:connectionId/system-info', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }
        
        // Get system resources for basic info
        const sysResources = await connection.write('/system/resource/print');
        
        // Get RouterOS version info (more detailed than in /system/resource)
        const routerOsInfo = await connection.write('/system/package/update/print');
        
        // Get identity (router name)
        const identityInfo = await connection.write('/system/identity/print');
        
        // Format uptime to be more human-readable
        let uptime = sysResources[0].uptime || 'Unknown';
        
        // Get router health info if available (may not be on all RouterOS versions)
        let healthInfo = {};
        try {
            const health = await connection.write('/system/health/print');
            if (health && health.length > 0) {
                healthInfo = health[0];
            }
        } catch (healthError) {
            // Health info not available, continue without it
            console.log('Health information not available:', healthError.message);
        }
        
        // Get license info
        const licenseInfo = await connection.write('/system/license/print');
        
        // Collect all information
        res.json({
            success: true,
            data: {
                identity: identityInfo[0]?.name || 'Unknown',
                model: sysResources[0]['board-name'] || 'Unknown',
                serialNumber: sysResources[0]['serial-number'] || 'Unknown',
                routerOS: {
                    version: sysResources[0].version || 'Unknown',
                    buildTime: sysResources[0]['build-time'] || 'Unknown',
                    factory_software: sysResources[0]['factory-software'] || 'Unknown',
                    updateChannel: routerOsInfo[0]?.['channel'] || 'Unknown',
                    currentFirmware: routerOsInfo[0]?.['installed-version'] || sysResources[0].version || 'Unknown'
                },
                uptime: uptime,
                architecture: sysResources[0].architecture || 'Unknown',
                cpu: {
                    model: sysResources[0].cpu || 'Unknown',
                    count: sysResources[0]['cpu-count'] || '1',
                    frequency: sysResources[0]['cpu-frequency'] || '600',
                    threads: sysResources[0]['cpu-threads'] || 'Unknown'
                },
                firmware: sysResources[0].firmware || 'Unknown',
                health: healthInfo,
                license: {
                    level: licenseInfo[0]?.['software-id'] || 'Unknown',
                    deadline: licenseInfo[0]?.deadline || 'None'
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false, 
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get combined status (active users + resources)
app.get('/api/router/:connectionId/status', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get router info
        const router = await getRouterById(connectionId);
        
        // Get active users
        const command = '/ip/hotspot/active/print';
        const activeUsers = await connection.write(command);
        
        // Filter by hotspot interface if specified
        let filteredUsers = activeUsers;
        if (router && router.hotspotName) {
            filteredUsers = activeUsers.filter(user => 
                user.server && user.server === router.hotspotName
            );
        }
        
        // Get CPU information
        const cpuInfo = await connection.write('/system/resource/cpu/print');
        
        // Get system resources
        const sysResources = await connection.write('/system/resource/print');
        
        // Get RouterOS identity
        const identityInfo = await connection.write('/system/identity/print');
        
        // Process CPU load
        const totalCpuLoad = cpuInfo.reduce((sum, core) => sum + parseInt(core.load), 0);
        const avgCpuLoad = cpuInfo.length > 0 ? totalCpuLoad / cpuInfo.length : 0;
        const cpuLoadPercentage = avgCpuLoad.toFixed(1);
        
        // Format memory usage
        const totalMemory = parseFloat(sysResources[0]['total-memory'] || 0) / (1024 * 1024);
        const freeMemory = parseFloat(sysResources[0]['free-memory'] || 0) / (1024 * 1024);
        const usedMemory = totalMemory - freeMemory;
        
        // Format disk usage
        const totalHdd = parseFloat(sysResources[0]['total-hdd-space'] || 0) / (1024 * 1024);
        const freeHdd = parseFloat(sysResources[0]['free-hdd-space'] || 0) / (1024 * 1024);
        const usedHdd = totalHdd - freeHdd;
        
        res.json({
            success: true,
            data: {
                activeUsers: {
                    total: filteredUsers.length,
                    users: filteredUsers
                },
                resources: {
                    cpu: {
                        loadPercentage: cpuLoadPercentage,
                        frequencyMHz: sysResources[0]['cpu-frequency'] || '600',
                        cores: cpuInfo.length,
                        model: sysResources[0]['cpu'] || 'Unknown'
                    },
                    memory: {
                        total: totalMemory.toFixed(2),
                        used: usedMemory.toFixed(2),
                        free: freeMemory.toFixed(2),
                        usedPercentage: ((usedMemory / totalMemory) * 100).toFixed(1)
                    },
                    disk: {
                        total: totalHdd.toFixed(2),
                        used: usedHdd.toFixed(2),
                        free: freeHdd.toFixed(2),
                        usedPercentage: ((usedHdd / totalHdd) * 100).toFixed(1)
                    }
                },
                system: {
                    identity: identityInfo[0]?.name || 'Unknown',
                    model: sysResources[0]['board-name'] || 'Unknown',
                    version: sysResources[0].version || 'Unknown',
                    uptime: sysResources[0].uptime || 'Unknown',
                    serialNumber: sysResources[0]['serial-number'] || 'Unknown'
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get logs for a specific connection
app.get('/api/router/:connectionId/logs', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const { limit = 20, page = 1, type, startDate, endDate } = req.query;
        
        // Initialize empty logs array if it doesn't exist
        if (!connectionLogs.has(connectionId)) {
            connectionLogs.set(connectionId, []);
        }
        
        // Get logs for this connection
        let logs = connectionLogs.get(connectionId) || [];
        
        // Apply filters if provided
        if (type) {
            logs = logs.filter(log => log.type === type);
        }
        
        // Safely parse and apply date filters
        if (startDate) {
            try {
                const startTimestamp = new Date(startDate);
                if (!isNaN(startTimestamp.getTime())) {
                    logs = logs.filter(log => {
                        try {
                            const logDate = new Date(log.timestamp);
                            return !isNaN(logDate.getTime()) && logDate >= startTimestamp;
                        } catch {
                            return false;
                        }
                    });
                }
            } catch (dateError) {
                console.error('Invalid startDate:', dateError);
            }
        }
        
        if (endDate) {
            try {
                const endTimestamp = new Date(endDate);
                if (!isNaN(endTimestamp.getTime())) {
                    logs = logs.filter(log => {
                        try {
                            const logDate = new Date(log.timestamp);
                            return !isNaN(logDate.getTime()) && logDate <= endTimestamp;
                        } catch {
                            return false;
                        }
                    });
                }
            } catch (dateError) {
                console.error('Invalid endDate:', dateError);
            }
        }
        
        // Ensure limit and page are valid numbers
        const parsedLimit = Math.min(parseInt(limit) || 20, 50); // Max 50 items per page
        const parsedPage = Math.max(parseInt(page) || 1, 1);
        
        // Calculate pagination
        const startIndex = (parsedPage - 1) * parsedLimit;
        const endIndex = startIndex + parsedLimit;
        
        // Get paginated results
        const paginatedLogs = logs.slice(startIndex, endIndex);
        
        // Process logs to ensure safe serialization
        const processedLogs = paginatedLogs.map(log => {
            let parsedDetails = null;
            if (log.details) {
                try {
                    parsedDetails = JSON.parse(log.details);
                } catch (error) {
                    parsedDetails = { error: "Could not parse details" };
                }
            }
            
            return {
                timestamp: log.timestamp || null,
                time: log.time || null,
                type: log.type || 'unknown',
                description: log.description ? 
                    (log.description.length > 1000 ? 
                        log.description.substring(0, 997) + "..." : 
                        log.description) : 
                    '',
                details: parsedDetails
            };
        });
        
        // Create a log entry for this request only if the connection is active
        if (connections.has(connectionId)) {
            try {
            createLogEntry(
                connectionId,
                'Logs retrieved',
                'info',
                    { 
                        page: parsedPage,
                        limit: parsedLimit,
                        totalLogs: logs.length,
                        returnedLogs: processedLogs.length
                    }
                );
            } catch (logError) {
                console.error('Error creating log entry:', logError);
            }
        }
        
        res.json({
            success: true,
            data: {
                total: logs.length,
                page: parsedPage,
                limit: parsedLimit,
                totalPages: Math.ceil(logs.length / parsedLimit),
                logs: processedLogs
            }
        });
    } catch (error) {
        console.error('Error in /logs endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Clear logs for a specific connection
app.delete('/api/router/:connectionId/logs', async (req, res) => {
    try {
        const { connectionId } = req.params;
        
        if (!connectionLogs.has(connectionId)) {
            return res.status(404).json({
                success: false,
                message: 'No logs found for this connection ID'
            });
        }
        
        // Create a final log entry about clearing logs
        if (connections.has(connectionId)) {
            createLogEntry(
                connectionId,
                'Logs cleared by user request',
                'warning',
                { previousLogCount: connectionLogs.get(connectionId).length }
            );
        }
        
        // Clear all but the most recent log (which is the "logs cleared" entry)
        const logs = connectionLogs.get(connectionId);
        connectionLogs.set(connectionId, logs.slice(0, 1));
        
        res.json({
            success: true,
            message: 'Logs cleared successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

/// Store previous readings
const interfaceReadings = new Map();

// NEW ENDPOINT: Get basic interface statistics
app.get('/api/router/:connectionId/simple-traffic', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const { interface } = req.query;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get all interfaces with their statistics
        const interfaces = await connection.write('/interface/print');
        
        // Filter to specific interface if requested
        let targetInterfaces = interfaces;
        if (interface) {
            targetInterfaces = interfaces.filter(iface => iface.name === interface);
            if (targetInterfaces.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: `Interface '${interface}' not found`
                    });
                }
        }
        
        // Get the current timestamp
        const now = Date.now();
        
        // Process each interface
        const results = [];
        for (const iface of targetInterfaces) {
            try {
                // Get interface traffic data using the correct command
                const stats = await connection.write('/interface/monitor-traffic', [
                    '=interface=' + iface.name,
                    '=once='
                ]);
                
                if (stats && stats.length > 0) {
                    const stat = stats[0];
                    const txBps = parseInt(stat['tx-bits-per-second'] || 0);
                    const rxBps = parseInt(stat['rx-bits-per-second'] || 0);
                    
                    results.push({
                        interface: iface.name,
                        type: iface.type,
                        running: iface.running === 'true',
                            tx: {
                            bps: txBps,
                            formatted: formatBitrate(txBps)
                            },
                            rx: {
                            bps: rxBps,
                            formatted: formatBitrate(rxBps)
                        },
                        timestamp: new Date(now).toISOString(),
                        time: new Date(now).toLocaleTimeString()
                    });
                }
            } catch (error) {
                // Try getting raw interface statistics instead
                try {
                    const rawStats = await connection.write('/interface/print', [
                        '=.proplist=name,tx-byte,rx-byte',
                        '?.name=' + iface.name
                    ]);
                    
                    if (rawStats && rawStats.length > 0) {
                        const rawStat = rawStats[0];
                        
                        // Calculate rates based on previous readings
                        const readingKey = `${connectionId}-${iface.name}`;
                        const currentReading = {
                            timestamp: now,
                            txBytes: parseInt(rawStat['tx-byte'] || 0),
                            rxBytes: parseInt(rawStat['rx-byte'] || 0)
                        };
                        
                        const prevReading = interfaceReadings.get(readingKey);
                        let txBps = 0;
                        let rxBps = 0;
                        
                        if (prevReading) {
                            const elapsedSec = (now - prevReading.timestamp) / 1000;
                            if (elapsedSec > 0) {
                                txBps = ((currentReading.txBytes - prevReading.txBytes) / elapsedSec) * 8;
                                rxBps = ((currentReading.rxBytes - prevReading.rxBytes) / elapsedSec) * 8;
                            }
                        }
                        
                        // Store current reading for next time
                        interfaceReadings.set(readingKey, currentReading);
                        
                        results.push({
                    interface: iface.name,
                            type: iface.type,
                            running: iface.running === 'true',
                            tx: {
                                bps: txBps,
                                formatted: formatBitrate(txBps)
                            },
                            rx: {
                                bps: rxBps,
                                formatted: formatBitrate(rxBps)
                            },
                            timestamp: new Date(now).toISOString(),
                            time: new Date(now).toLocaleTimeString(),
                            note: "Calculated from byte counters"
                        });
                    }
                } catch (statsError) {
                    results.push({
                        interface: iface.name,
                        type: iface.type,
                        running: iface.running === 'true',
                        error: "Could not retrieve traffic data",
                        details: statsError.message
                    });
                }
            }
        }
        
        res.json({
            success: true,
            data: results
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Server error',
                    error: error.message
        });
    }
});


// NEW ENDPOINT: Get Mikrotik Hotspot logs (simplified version)
// IMPROVED ENDPOINT: Get Mikrotik Hotspot logs with better user extraction
app.get('/api/router/:connectionId/hotspot-logs', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }
        
        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Hotspot logs requested',
            'info'
        );
        
        // Fetch logs with the simple command without parameters
        let logs = [];
        try {
            logs = await connection.write('/log/print');
        } catch (logError) {
            console.error('Error fetching logs with basic command:', logError);
            return res.status(500).json({
                    success: false,
                message: 'Failed to fetch logs',
                error: logError.message
            });
        }
        
        // Filter logs related to hotspot
        const hotspotKeywords = ['hotspot', 'login', 'logout', 'radius', 'ppp', 'user', 'dhcp'];
        
        // Process logs to extract time, user, IP and message
        const processedLogs = logs
            .filter(log => {
                // Check if the log contains any hotspot-related keywords
                const message = log.message || '';
                return hotspotKeywords.some(keyword => 
                    message.toLowerCase().includes(keyword.toLowerCase())
                );
            })
            .map(log => {
                // Extract time
                let timestamp = log.time || '';
                
                // Extract username from message - IMPROVED VERSION
                let user = '';
                const message = log.message || '';
                
                // Several patterns to try for different log message formats
                
                // Pattern 1: Direct username in logs - "user username logged in/out"
                const userPatternDirect = /user\s+(\S+)\s+logged/i;
                const userMatchDirect = message.match(userPatternDirect);
                
                // Pattern 2: Hotspot format - "->: username (ip): action"
                const userPatternHotspot = /->:\s+([^(]+)\s*\(/i;
                const userMatchHotspot = message.match(userPatternHotspot);
                
                if (userMatchDirect) {
                    user = userMatchDirect[1];
                } else if (userMatchHotspot) {
                    user = userMatchHotspot[1].trim();
                }
                
                // Extract IP address
                let ip = '';
                const ipMatch = message.match(/(?:\d{1,3}\.){3}\d{1,3}/);
                if (ipMatch) {
                    ip = ipMatch[0];
                }
                
                // For MAC addresses 
                let mac = '';
                const macMatch = message.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                if (macMatch) {
                    mac = macMatch[0];
                }
                
                // Determine log type/status
                let status = 'info';
                if (message.includes('logged in')) {
                    status = 'login-success';
                } else if (message.includes('logged out')) {
                    status = 'logout';
                } else if (message.includes('login failed')) {
                    status = 'login-failure';
                    
                    // Extract reason for login failure
                    const reasonMatch = message.match(/login failed: ([^"]+?)(?:$|\s*")/);
                    if (reasonMatch) {
                        status = `login-failure: ${reasonMatch[1].trim()}`;
                    }
                }
                
                return {
                    time: timestamp,
                    date: log.date || '',
                    user: user,
                    ip: ip,
                    mac: mac,
                    message: message,
                    status: status
                };
            });
        
        res.json({
            success: true,
            data: {
                total: processedLogs.length,
                logs: processedLogs
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot logs:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get all hotspot users (including those created via Mikhmon)
app.get('/api/router/:connectionId/hotspot-users', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
            createLogEntry(
                connectionId,
            'Hotspot users list requested',
            'info'
        );
        
        // First, get all configured hotspot users
        let users = [];
        try {
            // This command gets all hotspot users configured on the router
            users = await connection.write('/ip/hotspot/user/print');
        } catch (userError) {
            console.error('Error fetching hotspot users:', userError);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch hotspot users',
                error: userError.message
            });
        }
        
        // Then, get all active hotspot users (currently connected)
        let activeUsers = [];
        try {
            activeUsers = await connection.write('/ip/hotspot/active/print');
        } catch (activeError) {
            console.error('Error fetching active hotspot users:', activeError);
            // Continue with just the configured users
        }
        
        // Format user data
        const formattedUsers = users.map(user => {
            // Find if this user is currently active
            const activeSession = activeUsers.find(active => active.user === user.name);
            
            return {
                username: user.name || '',
                password: user.password || '',
                profile: user.profile || 'default',
                limitUptime: user['limit-uptime'] || 'unlimited',
                limitBytesIn: formatBytes(parseInt(user['limit-bytes-in'] || 0)),
                limitBytesOut: formatBytes(parseInt(user['limit-bytes-out'] || 0)),
                limitBytesTotal: formatBytes(parseInt(user['limit-bytes-total'] || 0)),
                disabled: user.disabled === 'true',
                comment: user.comment || '',
                createdBy: getUserCreator(user),
                lastLogout: user['last-logged-out'] || '',
                isActive: !!activeSession,
                activeSession: activeSession ? {
                    ip: activeSession.address || '',
                    mac: activeSession['mac-address'] || '',
                    uptime: activeSession.uptime || '',
                    bytesIn: formatBytes(parseInt(activeSession['bytes-in'] || 0)),
                    bytesOut: formatBytes(parseInt(activeSession['bytes-out'] || 0))
                } : null
            };
        });
        
        // Also include active users that might not be in the user list
        // (this can happen with certain authentication methods)
        activeUsers.forEach(active => {
            if (active.user && !formattedUsers.some(u => u.username === active.user)) {
                formattedUsers.push({
                    username: active.user || '',
                    password: '',  // Empty password for active users not in the user list
                    profile: active.profile || 'default',
                    isActive: true,
                    activeSession: {
                        ip: active.address || '',
                        mac: active['mac-address'] || '',
                        uptime: active.uptime || '',
                        bytesIn: formatBytes(parseInt(active['bytes-in'] || 0)),
                        bytesOut: formatBytes(parseInt(active['bytes-out'] || 0))
                    }
                });
            }
        });
        
        res.json({
            success: true,
            data: {
                total: formattedUsers.length,
                activeCount: activeUsers.length,
                users: formattedUsers
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot users:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Create new hotspot user
app.post('/api/router/:connectionId/hotspot-users', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        const {
            server,
            name,
            password,
            macAddress,
            profile,
            timeLimit,
            dataLimit,
            comment,
            limitUpTime,
            limitBitesTotal,
            userCode,
            expireDate
        } = req.body;

        // Validate required fields
        if (!name || !password || !profile) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, password, or profile'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Creating new hotspot user: ${name}`,
            'info'
        );

        // Prepare command parameters
        const params = [
            '=name=' + name,
            '=password=' + password,
            '=profile=' + profile,
        ];

        // Add optional parameters if provided
        if (server && server !== 'all') params.push('=server=' + server);
        if (macAddress) params.push('=mac-address=' + macAddress);
        if (timeLimit) params.push('=limit-uptime=' + timeLimit);
        if (dataLimit) params.push('=limit-bytes-total=' + dataLimit);
        if (comment) params.push('=comment=' + comment);
        if (limitUpTime) params.push('=limit-uptime=' + limitUpTime);
        if (limitBitesTotal) params.push('=limit-bytes-total=' + limitBitesTotal);
        if (userCode) params.push('=user-code=' + userCode);
        if (expireDate) params.push('=expire-date=' + expireDate);

        // Create the user
        await connection.write('/ip/hotspot/user/add', params);

        // Save user to database with password
        await db.updateHotspotUser(connectionId, {
            Name: name,
            Password: password,
            Profile: profile,
            Server: server || 'all',
            MacAddress: macAddress || '',
            Comment: comment || '',
            LimitUpTime: limitUpTime || '',
            LimitBytesTotal: limitBitesTotal || ''
        });

        // Log success
        createLogEntry(
            connectionId,
            `Successfully created hotspot user: ${name}`,
            'success',
            { profile, server }
        );

        // Get the created user's details
        const users = await connection.write('/ip/hotspot/user/print', [
            '?name=' + name
        ]);

        const createdUser = users[0];

        res.json({
            success: true,
            message: 'User created successfully',
            data: {
                name: createdUser.name,
                password: password,  // Include password in response
                profile: createdUser.profile,
                server: createdUser.server || 'all',
                macAddress: createdUser['mac-address'] || '',
                limitUptime: createdUser['limit-uptime'] || '',
                limitBytesTotal: createdUser['limit-bytes-total'] || '',
                comment: createdUser.comment || ''
            }
        });
        
    } catch (error) {
        console.error('Error creating hotspot user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create user',
            error: error.message
        });
    }
});

// Helper function to format bytes into human-readable format
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Try to determine user creator from comment field or other indicators
function getUserCreator(user) {
    const comment = (user.comment || '').toLowerCase();
    
    if (comment.includes('mikhmon')) {
        return 'Mikhmon';
    } else if (comment.includes('api')) {
        return 'API';
    } else if (user['on-login'] && user['on-login'].includes('mikhmon')) {
        return 'Mikhmon';
    } else {
        return 'Manual/Unknown';
    }
}

// ENHANCEMENT: Add endpoint to search logs for a specific user
app.get('/api/router/:connectionId/hotspot-logs/user/:username', async (req, res) => {
    try {
        const { connectionId, username } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }
        
        // Create log entry for this request
            createLogEntry(
                connectionId,
            `Hotspot logs requested for user: ${username}`,
            'info'
        );
        
        // Fetch all logs
        let logs = [];
        try {
            logs = await connection.write('/log/print');
        } catch (logError) {
            console.error('Error fetching logs with basic command:', logError);
            return res.status(500).json({
                    success: false,
                message: 'Failed to fetch logs',
                error: logError.message
            });
        }
        
        // Filter logs related to the specific user
        const userLogs = logs
            .filter(log => {
                const message = log.message || '';
                
                // Check for different patterns of username in log
                return (
                    // Hotspot format: "->: username (ip): action"
                    message.includes(`->: ${username} (`) ||
                    // Direct username in logs
                    message.includes(`user ${username} logged`) ||
                    // Other potential matches
                    message.includes(`username=${username}`) ||
                    message.includes(`user=${username}`)
                );
            })
            .map(log => {
                // Apply same processing as in the main logs endpoint
                let timestamp = log.time || '';
                const message = log.message || '';
                
                // Extract IP address
                let ip = '';
                const ipMatch = message.match(/(?:\d{1,3}\.){3}\d{1,3}/);
                if (ipMatch) {
                    ip = ipMatch[0];
                }
                
                // For MAC addresses 
                let mac = '';
                const macMatch = message.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                if (macMatch) {
                    mac = macMatch[0];
                }
                
                // Determine log type/status
                let status = 'info';
                if (message.includes('logged in')) {
                    status = 'login-success';
                } else if (message.includes('logged out')) {
                    status = 'logout';
                } else if (message.includes('login failed')) {
                    status = 'login-failure';
                    
                    // Extract reason for login failure
                    const reasonMatch = message.match(/login failed: ([^"]+?)(?:$|\s*")/);
                    if (reasonMatch) {
                        status = `login-failure: ${reasonMatch[1].trim()}`;
                    }
                }
                
                return {
                    time: timestamp,
                    date: log.date || '',
                    user: username,
                    ip: ip,
                    mac: mac,
                    message: message,
                    status: status
                };
            });
        
        res.json({
            success: true,
            data: {
                username: username,
                total: userLogs.length,
                logs: userLogs
            }
        });
        
    } catch (error) {
        console.error(`Error fetching logs for user ${req.params.username}:`, error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// UPDATED ENDPOINT: Get hotspot users with improved server naming and data persistence
app.get('/api/router/:connectionId/hotspot-users-structured', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Structured hotspot users list requested',
            'info'
        );
        
        // Get router info to find hotspot server name
        const router = await getRouterById(connectionId);
        
        // Get all configured hotspot users
        const users = await connection.write('/ip/hotspot/user/print');
        
        // Get all active hotspot users (for uptime and traffic data)
        const activeUsers = await connection.write('/ip/hotspot/active/print');
        
        // Get server information
        const servers = await connection.write('/ip/hotspot/print');

        // Get stored user data
        const storedUsers = await getAllStoredUsers(connectionId);
        
        // Format the data in the requested structure
        const structuredUsers = users.map(user => {
            // Find if this user is currently active
            const activeSession = activeUsers.find(active => active.user === user.name);
            
            // Find stored data for this user
            const storedData = storedUsers.find(stored => stored.username === user.name);
            
            // Find MAC address - either from active session or from user binding if available
            let macAddress = '';
            if (activeSession && activeSession['mac-address']) {
                macAddress = activeSession['mac-address'];
                } else {
                // Try to get MAC from user binding if it exists
                try {
                    // This is optional and might not be available on all RouterOS versions
                    const userBindings = connection.write('/ip/hotspot/ip-binding/print', [
                        `?user=${user.name}`
                    ]);
                    if (userBindings && userBindings.length > 0 && userBindings[0]['mac-address']) {
                        macAddress = userBindings[0]['mac-address'];
                    }
                } catch (bindingError) {
                    // Binding lookup failed, continue without it
                }
            }
            
            // Find which server the user belongs to - use "all" as default
            // following Mikhmon's convention
            let userServer = 'all';
            
            // If user is active, use the specific server they're connected to
            if (activeSession && activeSession.server) {
                userServer = activeSession.server;
            }
            
            // If the user has a server specified in their profile, use that
            if (user.server) {
                userServer = user.server;
            }

            // Prepare user data, using active session data if available, otherwise use stored data
            const userData = {
                Server: userServer,
                Name: user.name || '',
                Profile: user.profile || 'default',
                MacAddress: macAddress || (storedData ? storedData.mac_address : ''),
                Uptime: activeSession ? activeSession.uptime || '00:00:00' : (storedData ? storedData.last_uptime : '00:00:00'),
                BytesIn: activeSession ? formatBytes(parseInt(activeSession['bytes-in'] || 0)) : (storedData ? storedData.last_bytes_in : '0 B'),
                BytesOut: activeSession ? formatBytes(parseInt(activeSession['bytes-out'] || 0)) : (storedData ? storedData.last_bytes_out : '0 B'),
                Comment: user.comment || (storedData ? storedData.comment : '')
            };

            // Store the current state in the database (don't await to avoid slowing down the response)
            if (activeSession || !storedData) {
                updateHotspotUser(connectionId, userData).catch(err => {
                    console.error(`Error storing user data for ${userData.Name}:`, err);
                });
            }

            return userData;
        });
        
        res.json({
            success: true,
            data: {
                total: structuredUsers.length,
                users: structuredUsers
            }
        });
        
            } catch (error) {
        console.error('Error fetching structured hotspot users:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// UPDATED ENDPOINT: Get hotspot users data in CSV format with improved server naming
app.get('/api/router/:connectionId/hotspot-users-export', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const { format = 'json' } = req.query; // 'json' or 'csv'
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
            createLogEntry(
                connectionId,
            `Hotspot users export requested in ${format} format`,
            'info'
        );
        
        // Get all configured hotspot users
        const users = await connection.write('/ip/hotspot/user/print');
        
        // Get all active hotspot users (for uptime and traffic data)
        const activeUsers = await connection.write('/ip/hotspot/active/print');
        
        // Format the data in the requested structure
        const structuredUsers = users.map(user => {
            // Find if this user is currently active
            const activeSession = activeUsers.find(active => active.user === user.name);
            
            // Find MAC address - either from active session or from user binding if available
            let macAddress = '';
            if (activeSession && activeSession['mac-address']) {
                macAddress = activeSession['mac-address'];
            }
            
            // Use "all" as the default server name (Mikhmon convention)
            let userServer = 'all';
            
            // If user is active, use the specific server they're connected to
            if (activeSession && activeSession.server) {
                userServer = activeSession.server;
            }
            
            // If the user has a server specified in their profile, use that
            if (user.server) {
                userServer = user.server;
            }
            
            return {
                Server: userServer,
                Name: user.name || '',
                Profile: user.profile || 'default',
                MacAddress: macAddress,
                Uptime: activeSession ? activeSession.uptime || '00:00:00' : '00:00:00',
                BytesIn: activeSession ? formatBytes(parseInt(activeSession['bytes-in'] || 0)) : '0 B',
                BytesOut: activeSession ? formatBytes(parseInt(activeSession['bytes-out'] || 0)) : '0 B',
                Comment: user.comment || ''
            };
        });
        
        // Return data in requested format
        if (format.toLowerCase() === 'csv') {
            // Generate CSV
            const csvHeader = 'Server,Name,Profile,MacAddress,Uptime,BytesIn,BytesOut,Comment\n';
            const csvRows = structuredUsers.map(user => {
                return [
                    user.Server,
                    user.Name,
                    user.Profile,
                    user.MacAddress,
                    user.Uptime,
                    user.BytesIn,
                    user.BytesOut,
                    `"${user.Comment.replace(/"/g, '""')}"`  // Escape quotes in comment
                ].join(',');
            }).join('\n');
            
            const csvContent = csvHeader + csvRows;
            
            // Set headers for CSV download
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="hotspot-users.csv"');
            res.send(csvContent);
        } else {
            // Return JSON as default
            res.json({
                success: true,
                data: {
                    total: structuredUsers.length,
                    users: structuredUsers
                }
            });
        }
        
    } catch (error) {
        console.error('Error exporting hotspot users:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// UPDATED ENDPOINT: Get hotspot configuration with enhanced data
app.get('/api/router/:connectionId/hotspot-config', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Hotspot configuration requested',
            'info'
        );
        
        // Get all hotspot servers
        const servers = await connection.write('/ip/hotspot/print');
        
        // Get all user profiles
        const profiles = await connection.write('/ip/hotspot/user/profile/print');

        // Get all users to extract unique comments
        const users = await connection.write('/ip/hotspot/user/print');

        // Format server data
        const formattedServers = servers.map(server => ({
            name: server.name || 'all',
            interface: server.interface || '',
            profile: server['profile'] || 'default',
            addresses: server['addresses-pool'] || ''
        }));

        // Format profile data with more details
        const formattedProfiles = profiles.map(profile => ({
            name: profile.name || 'default',
            sharedUsers: profile['shared-users'] || '1',
            rateLimit: profile['rate-limit'] || 'unlimited',
            validity: profile.validity || '',
            price: profile.price || '0',
            sellingPrice: profile['selling-price'] || '0',
            sessionTimeout: profile['session-timeout'] || '',
            idleTimeout: profile['idle-timeout'] || 'none',
            keepaliveTimeout: profile['keepalive-timeout'] || '2m',
            statusAutorefresh: profile['status-autorefresh'] || '1m',
            macCookieTimeout: profile['mac-cookie-timeout'] || '3d',
            mikrotikProfile: 1
        }));

        // Extract unique comments (excluding empty ones)
        const uniqueComments = [...new Set(users
            .map(user => user.comment)
            .filter(comment => comment && comment.trim() !== '')
        )];

        // Always include 'all' in servers if not present
        if (!formattedServers.find(server => server.name === 'all')) {
            formattedServers.unshift({ name: 'all', interface: '', profile: 'default', addresses: '' });
        }

        // Always include 'default' in profiles if not present
        if (!formattedProfiles.find(profile => profile.name === 'default')) {
            formattedProfiles.unshift({
                name: 'default',
                sharedUsers: '1',
                rateLimit: 'unlimited',
                validity: '',
                price: '0',
                sellingPrice: '0',
                sessionTimeout: '',
                idleTimeout: '',
                keepaliveTimeout: '',
                statusAutorefresh: '1m',
                macCookieTimeout: '3d',
                mikrotikProfile: 1
            });
        }

        // Get router settings to get currency
        const router = await getRouterById(parseInt(connectionId));
        const currency = router?.currency || 'LRD';

        // Process and store each profile from MikroTik
        await Promise.all(profiles.map(async (profile) => {
            // Extract validity from on-login script
            let validity = extractValidityFromScript(profile['on-login']) || '';
            
            // Get existing profile from database to preserve price and selling price
            const existingProfile = routerProfiles.find(p => p.name === (profile.name || 'default'));
            
            // Extract data from MikroTik
            const mikrotikProfile = {
                router_id: parseInt(connectionId),
                name: profile.name || 'default',
                shared_users: profile['shared-users'] || '1',
                rate_limit: profile['rate-limit'] || 'unlimited',
                validity: validity,
                user_lock: profile['address-list'] ? 'yes' : 'no',
                server_lock: profile.server ? 'yes' : 'no',
                expire_mode: existingProfile?.expire_mode || "Remove & Record",
                price: existingProfile?.price ? existingProfile.price.replace(/ LRD/g, '') : '100',
                selling_price: existingProfile?.selling_price ? existingProfile.selling_price.replace(/ LRD/g, '') : '100',
                session_timeout: profile['session-timeout'] || '',
                idle_timeout: profile['idle-timeout'] || 'none',
                keepalive_timeout: profile['keepalive-timeout'] || '2m',
                status_autorefresh: profile['status-autorefresh'] || '1m',
                mac_cookie_timeout: profile['mac-cookie-timeout'] || '3d',
                mikrotik_profile: 1
            };

            // Store in database
            await upsertHotspotProfile(mikrotikProfile);
        }));

        // Get updated profiles from database
        const updatedProfiles = await getAllHotspotProfiles();
        const updatedRouterProfiles = updatedProfiles.filter(profile => profile.router_id === parseInt(connectionId));

        // Remove duplicates by keeping only the latest version of each profile
        const uniqueProfiles = updatedRouterProfiles.reduce((acc, profile) => {
            const existing = acc.find(p => p.name === profile.name);
            if (!existing || new Date(profile.updated_at) > new Date(existing.updated_at)) {
                if (existing) {
                    acc = acc.filter(p => p.name !== profile.name);
                }
                acc.push(profile);
            }
            return acc;
        }, []);

        // Add currency to prices only for the response
        const responseProfiles = uniqueProfiles.map(profile => ({
            ...profile,
            price: `${profile.price} ${currency}`,
            selling_price: `${profile.selling_price} ${currency}`
        }));

        res.json({
            success: true,
            data: {
                total: responseProfiles.length,
                profiles: responseProfiles,
                deleted: profilesToDelete.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot configuration:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get and store hotspot profiles
app.get('/api/router/:connectionId/hotspot-profiles', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Hotspot profiles requested',
            'info'
        );
        
        // Get all user profiles from MikroTik
        const profiles = await connection.write('/ip/hotspot/user/profile/print');
        
        // Function to extract validity from on-login script
        function extractValidityFromScript(script) {
            if (!script) return '';
            
            // Look for interval pattern
            const intervalMatch = script.match(/interval=\"([^\"]+)\"/);
            if (intervalMatch && intervalMatch[1]) {
                return intervalMatch[1]; // This would return "1d", "1w", etc.
            }
            
            return '';
        }
        
        // Get all profiles from database for this router
        const allProfiles = await getAllHotspotProfiles();
        const routerProfiles = allProfiles.filter(profile => profile.router_id === parseInt(connectionId));
                
        // Extract profile names from MikroTik response
        const mikrotikProfileNames = profiles.map(p => p.name || 'default');
        
        // Find profiles in our database that don't exist in MikroTik anymore
        const profilesToDelete = routerProfiles.filter(
            profile => !mikrotikProfileNames.includes(profile.name)
        );
        
        // Delete profiles that no longer exist in MikroTik
        for (const profile of profilesToDelete) {
            await deleteHotspotProfile(profile.router_id, profile.name);
        }
        
        // Process and store each profile from MikroTik
        await Promise.all(profiles.map(async (profile) => {
            // Extract validity from on-login script
            let validity = extractValidityFromScript(profile['on-login']) || '';
            
            // Get existing profile from database to preserve price and selling price
            const existingProfile = routerProfiles.find(p => p.name === (profile.name || 'default'));
            
            // Extract data from MikroTik
            const mikrotikProfile = {
                router_id: parseInt(connectionId),
                name: profile.name || 'default',
                shared_users: profile['shared-users'] || '1',
                rate_limit: profile['rate-limit'] || 'unlimited',
                validity: validity,
                user_lock: profile['address-list'] ? 'yes' : 'no',
                server_lock: profile.server ? 'yes' : 'no',
                expire_mode: existingProfile?.expire_mode || "Remove & Record",
                price: existingProfile?.price ? existingProfile.price.replace(/ LRD/g, '') : '100',
                selling_price: existingProfile?.selling_price ? existingProfile.selling_price.replace(/ LRD/g, '') : '100',
                session_timeout: profile['session-timeout'] || '',
                idle_timeout: profile['idle-timeout'] || 'none',
                keepalive_timeout: profile['keepalive-timeout'] || '2m',
                status_autorefresh: profile['status-autorefresh'] || '1m',
                mac_cookie_timeout: profile['mac-cookie-timeout'] || '3d',
                mikrotik_profile: 1
            };

            // Store in database
            await upsertHotspotProfile(mikrotikProfile);
        }));

        // Get updated profiles from database
        const updatedProfiles = await getAllHotspotProfiles();
        const updatedRouterProfiles = updatedProfiles.filter(profile => profile.router_id === parseInt(connectionId));

        // Remove duplicates by keeping only the latest version of each profile      
        const uniqueProfiles = updatedRouterProfiles.reduce((acc, profile) => {
            const existing = acc.find(p => p.name === profile.name);
            if (!existing || new Date(profile.updated_at) > new Date(existing.updated_at)) {
                if (existing) {
                    acc = acc.filter(p => p.name !== profile.name);
                }
                acc.push(profile);
            }
            return acc;
        }, []);

        res.json({
            success: true,
            data: {
                total: uniqueProfiles.length,
                profiles: uniqueProfiles,
                deleted: profilesToDelete.length
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot profiles:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Create new hotspot profile
app.post('/api/router/:connectionId/hotspot-profiles', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        const {
            name,
            addressPool = "pool.hs",
            sharedUsers = "1",
            rateLimit = "",
            parentQueue = "none",
            expiredMode = "Remove & Record",
            validity = "",
            lockUser = "no",
            lockServer = "no",
            idleTimeout = "none",
            keepaliveTimeout = "2m",
            statusAutorefresh = "1m",
            macCookieTimeout = "3d",
            price,
            selling_price
        } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: name'
            });
        }

        // Validate price and selling price
        if (!price || !selling_price) {
            return res.status(400).json({
                success: false,
                message: 'Both price and selling price are required'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Creating new hotspot profile: ${name} with price: ${price} and selling price: ${selling_price}`,
            'info'
        );

        // Prepare basic command parameters
        const params = [
            '=name=' + name,
            '=address-pool=' + addressPool,
            '=shared-users=' + sharedUsers
        ];

        // Add rate limit if provided
        if (rateLimit) params.push('=rate-limit=' + rateLimit);
        
        // Add parent queue if it's not "none"
        if (parentQueue && parentQueue !== "none") params.push('=parent-queue=' + parentQueue);
        
        // Handle address-list for user lock
        if (lockUser === "yes") {
            params.push('=address-list=hotspot-user-lock');
        }
        
        // Handle server lock
        if (lockServer === "yes") {
            // Get all hotspot servers
            const servers = await connection.write('/ip/hotspot/print');
            if (servers && servers.length > 0) {
                // Use the first server's name
                params.push('=server=' + servers[0].name);
            }
        }
        
        // Generate on-login script for validity if provided
        if (validity) {
            const onLoginScript = generateValidityScript(validity, price, expiredMode, name);
            params.push('=on-login=' + onLoginScript);
        }

        // Create the profile
        await connection.write('/ip/hotspot/user/profile/add', params);

        // Store in database
        const profileData = {
            router_id: parseInt(connectionId),
            name: name,
            shared_users: sharedUsers,
            rate_limit: rateLimit || 'unlimited',
            validity: validity,
            user_lock: lockUser,
            server_lock: lockServer,
            expire_mode: expiredMode,
            price: price,
            selling_price: selling_price,
            session_timeout: "",
            idle_timeout: idleTimeout,
            keepalive_timeout: keepaliveTimeout,
            status_autorefresh: statusAutorefresh,
            mac_cookie_timeout: macCookieTimeout,
            mikrotik_profile: 1
        };
        
        await upsertHotspotProfile(profileData);

        // Log success
        createLogEntry(
            connectionId,
            `Successfully created hotspot profile: ${name} with price: ${price} and selling price: ${selling_price}`,
            'success',
            { validity, expiredMode, price, selling_price }
        );

        res.json({
            success: true,
            message: 'Profile created successfully',
            data: profileData
        });
        
    } catch (error) {
        console.error('Error creating hotspot profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create profile',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Delete hotspot profile
app.delete('/api/router/:connectionId/hotspot-profiles/:profileName', async (req, res) => {
    try {
        const { connectionId, profileName } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Deleting hotspot profile: ${profileName}`,
            'info'
        );

        // Check if profile exists in MikroTik
        const profiles = await connection.write('/ip/hotspot/user/profile/print', [
            '?name=' + profileName
        ]);

        if (profiles.length === 0) {
            // If profile doesn't exist in MikroTik but exists in our DB, just delete from DB
            await deleteHotspotProfile(parseInt(connectionId), profileName);
            
            return res.json({
                success: true,
                message: 'Profile deleted from database',
                data: { deletedFromMikrotik: false }
            });
        }

        // Check if profile is in use by any users
        const users = await connection.write('/ip/hotspot/user/print', [
            '?profile=' + profileName
        ]);

        if (users.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete profile: it is being used by one or more users',
                data: { usersCount: users.length }
            });
        }

        // Delete profile from MikroTik
        await connection.write('/ip/hotspot/user/profile/remove', [
            '=numbers=' + profiles[0]['.id']
        ]);

        // Delete profile from database
        await deleteHotspotProfile(parseInt(connectionId), profileName);

        // Log success
        createLogEntry(
            connectionId,
            `Successfully deleted hotspot profile: ${profileName}`,
            'success'
        );

        res.json({
            success: true,
            message: 'Profile deleted successfully',
            data: { deletedFromMikrotik: true }
        });
        
    } catch (error) {
        console.error('Error deleting hotspot profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete profile',
            error: error.message
        });
    }
});

// Helper function to generate validity script based on Mikhmon approach
function generateValidityScript(validity, price, expiredMode, profileName) {
    // Use the actual price passed in
    const actualPrice = price;
    
    // Default to X mode (Remove & Record)
    let mode = "X";
    
    // Set mode based on expiration mode
    if (expiredMode === "Lock User & Record") {
        mode = "D";
    } else if (expiredMode === "Lock Server & Record") {
        mode = "S";
    } else if (expiredMode === "Lock & Record") {
        mode = "B";
    }
    
    // Create the first part of the script based on Mikhmon's pattern
    const scriptStart = `:put (\",remc,${actualPrice},${validity},${actualPrice},,Enable,Disable,\"); :local mode \"${mode}\"; {`;
    
    // The main script logic for handling validity (based on Mikhmon's approach)
    const scriptBody = `:local date [ /system clock get date ];
:local year [ :pick $date 7 11 ];
:local month [ :pick $date 0 3 ];
:local comment [ /ip hotspot user get [/ip hotspot user find where name=\"$user\"] comment];
:local ucode [:pic $comment 0 2];
:if ($ucode = \"vc\" or $ucode = \"up\" or $comment = \"\") do={
  /sys sch add name=\"$user\" disable=no start-date=$date interval=\"${validity}\";
  :delay 2s;
  :local exp [ /sys sch get [ /sys sch find where name=\"$user\" ] next-run];
  :local getxp [len $exp];
  :if ($getxp = 15) do={
    :local d [:pic $exp 0 6];
    :local t [:pic $exp 7 16];
    :local s (\"/\");
    :local exp (\"$d$s$year $t\");
    /ip hotspot user set comment=\"$exp $mode\" [find where name=\"$user\"];
  };
  :if ($getxp = 8) do={
    /ip hotspot user set comment=\"$date $exp $mode\" [find where name=\"$user\"];
  };
  :if ($getxp > 15) do={
    /ip hotspot user set comment=\"$exp $mode\" [find where name=\"$user\"];
  };
  /sys sch remove [find where name=\"$user\"];
  :local mac $\"mac-address\";
  :local time [/system clock get time ];
  /system script add name=\"$date-|-$time-|-$user-|-${actualPrice}-|-$address-|-$mac-|-${validity}-|-${profileName}-|-$comment\" owner=\"$month$year\" source=$date comment=mikhmon;
  [:local mac $\"mac-address\"; /ip hotspot user set mac-address=$mac [find where name=$user]]
}}`;

    return scriptStart + scriptBody.replace(/\n/g, '');
}

// Get IP address pools
app.get('/api/router/:connectionId/ip-pools', async (req, res) => {
  const { connectionId } = req.params;
  const connection = connections.get(connectionId);

  if (!connection) {
    return res.status(404).json({ success: false, message: 'Connection not found' });
  }

  try {
    // Get IP pools from MikroTik
    const pools = await connection.write('/ip/pool/print');
    
    // Format the response
    const formattedPools = pools.map(pool => ({
      name: pool.name,
      ranges: pool.ranges,
      nextPool: pool.nextPool || 'none'
    }));

    res.json({
      success: true,
      data: formattedPools
    });
  } catch (error) {
    console.error('Error fetching IP pools:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch IP pools',
      error: error.message 
    });
  }
});

// UPDATED ENDPOINT: Update hotspot profile
app.put('/api/router/:connectionId/hotspot-profiles/:profileName', async (req, res) => {
    try {
        const { connectionId, profileName } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        const {
            name,
            addressPool,
            sharedUsers,
            rateLimit,
            parentQueue,
            expiredMode,
            validity,
            lockUser,
            lockServer,
            price,
            selling_price,
            idleTimeout,
            keepaliveTimeout,
            statusAutorefresh,
            macCookieTimeout
        } = req.body;

        // Validate price and selling price
        if (!price || !selling_price) {
            return res.status(400).json({
                success: false,
                message: 'Both price and selling price are required'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Updating hotspot profile: ${profileName}${name && name !== profileName ? ` to ${name}` : ''}`,
            'info'
        );

        // Check if profile exists and get current settings
        const profiles = await connection.write('/ip/hotspot/user/profile/print', [
            '?name=' + profileName
        ]);

        if (profiles.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        const currentProfile = profiles[0];
        const profileId = currentProfile['.id'];

        // If new name is provided, check if it already exists (unless it's the same name)
        if (name && name !== profileName) {
            const existingProfiles = await connection.write('/ip/hotspot/user/profile/print', [
                '?name=' + name
            ]);

            if (existingProfiles.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `A profile with the name "${name}" already exists`
                });
            }
        }

        // Use existing values for timeouts if not provided
        const finalIdleTimeout = idleTimeout ?? currentProfile['idle-timeout'] ?? 'none';
        const finalKeepaliveTimeout = keepaliveTimeout ?? currentProfile['keepalive-timeout'] ?? '2m';
        const finalStatusAutorefresh = statusAutorefresh ?? currentProfile['status-autorefresh'] ?? '1m';
        const finalMacCookieTimeout = macCookieTimeout ?? currentProfile['mac-cookie-timeout'] ?? '3d';

        // Store users with this profile to update them later
        const usersWithProfile = await connection.write('/ip/hotspot/user/print', [
            '?profile=' + profileName
        ]);

        // Build parameters for the new profile
        const addParams = [];
        
        // Add required parameters
        addParams.push('=name=' + (name || profileName));
        
        // Add optional parameters only if they are provided
        if (addressPool) addParams.push('=address-pool=' + addressPool);
        if (sharedUsers) addParams.push('=shared-users=' + sharedUsers);
        if (rateLimit) addParams.push('=rate-limit=' + rateLimit);
        if (parentQueue && parentQueue !== "none") addParams.push('=parent-queue=' + parentQueue);
        if (lockUser === "yes") addParams.push('=address-list=hotspot');
        
        // Add server parameter only if lockServer is "yes"
        if (lockServer === "yes") {
            const servers = await connection.write('/ip/hotspot/print');
            if (servers && servers.length > 0) {
                addParams.push('=server=' + servers[0].name);
            }
        }

        // Add timeout parameters only if they differ from defaults
        if (finalIdleTimeout !== 'none') addParams.push('=idle-timeout=' + finalIdleTimeout);
        if (finalKeepaliveTimeout !== '2m') addParams.push('=keepalive-timeout=' + finalKeepaliveTimeout);
        if (finalStatusAutorefresh !== '1m') addParams.push('=status-autorefresh=' + finalStatusAutorefresh);
        if (finalMacCookieTimeout !== '3d') addParams.push('=mac-cookie-timeout=' + finalMacCookieTimeout);
        
        // Add on-login script only if validity is provided
        if (validity) {
            const onLoginScript = generateValidityScript(validity, price, expiredMode, name || profileName);
            addParams.push('=on-login=' + onLoginScript);
        }

        try {
            // Create a temporary profile name to avoid conflicts
            const tempProfileName = `temp_${Date.now()}_${profileName}`;
            
            // First create the temporary profile
            await connection.write('/ip/hotspot/user/profile/add', [
                ...addParams.filter(param => !param.startsWith('=name=')),
                '=name=' + tempProfileName
            ]);

            // Move users to temporary profile
            for (const user of usersWithProfile) {
                await connection.write('/ip/hotspot/user/set', [
                    '=numbers=' + user['.id'],
                    '=profile=' + tempProfileName
                ]);
            }

            // Remove old profile
            await connection.write('/ip/hotspot/user/profile/remove', [
                '=numbers=' + profileId
            ]);

            // Create the new profile with the correct name
            await connection.write('/ip/hotspot/user/profile/add', addParams);

            // Move users to the new profile
            for (const user of usersWithProfile) {
                await connection.write('/ip/hotspot/user/set', [
                    '=numbers=' + user['.id'],
                    '=profile=' + (name || profileName)
                ]);
            }

            // Remove temporary profile
            const tempProfiles = await connection.write('/ip/hotspot/user/profile/print', [
                '?name=' + tempProfileName
            ]);
            if (tempProfiles.length > 0) {
                await connection.write('/ip/hotspot/user/profile/remove', [
                    '=numbers=' + tempProfiles[0]['.id']
                ]);
            }

            // If name changed, delete old profile from database
            if (name && name !== profileName) {
                await deleteHotspotProfile(parseInt(connectionId), profileName);
            }

            // Update in database
            const profileData = {
                router_id: parseInt(connectionId),
                name: name || profileName,
                shared_users: sharedUsers || '1',
                rate_limit: rateLimit || 'unlimited',
                validity: validity || '',
                user_lock: lockUser || 'no',
                server_lock: lockServer || 'no',
                expire_mode: expiredMode || "Remove & Record",
                price: price,
                selling_price: selling_price,
                session_timeout: "",
                idle_timeout: finalIdleTimeout,
                keepalive_timeout: finalKeepaliveTimeout,
                status_autorefresh: finalStatusAutorefresh,
                mac_cookie_timeout: finalMacCookieTimeout,
                mikrotik_profile: 1
            };
            
            await upsertHotspotProfile(profileData);

            createLogEntry(
                connectionId,
                `Successfully updated hotspot profile${name && name !== profileName ? ` and renamed from ${profileName} to ${name}` : ''}`,
                'success',
                { 
                    oldName: profileName,
                    newName: name || profileName,
                    validity, 
                    expiredMode, 
                    price, 
                    selling_price 
                }
            );

            res.json({
                success: true,
                message: `Profile ${name && name !== profileName ? 'renamed and ' : ''}updated successfully`,
                data: profileData
            });
        } catch (error) {
            // If there's an error, try to clean up
            try {
                // Get all profiles we need to check
                const profilesToCheck = [
                    name || profileName,
                    `temp_${Date.now()}_${profileName}`
                ];

                for (const profileToCheck of profilesToCheck) {
                    const checkProfiles = await connection.write('/ip/hotspot/user/profile/print', [
                        '?name=' + profileToCheck
                    ]);
                    if (checkProfiles.length > 0) {
                        // Move any users back to original profile name if possible
                        const usersToMove = await connection.write('/ip/hotspot/user/print', [
                            '?profile=' + profileToCheck
                        ]);
                        for (const user of usersToMove) {
                            try {
                                await connection.write('/ip/hotspot/user/set', [
                                    '=numbers=' + user['.id'],
                                    '=profile=' + profileName
                                ]);
                            } catch (moveError) {
                                console.error('Error moving user back:', moveError);
                            }
                        }
                        // Try to remove the profile
                        try {
                            await connection.write('/ip/hotspot/user/profile/remove', [
                                '=numbers=' + checkProfiles[0]['.id']
                            ]);
                        } catch (removeError) {
                            console.error('Error removing profile:', removeError);
                        }
                    }
                }
            } catch (cleanupError) {
                console.error('Error during cleanup:', cleanupError);
            }
            throw error;
        }
        
    } catch (error) {
        console.error('Error updating hotspot profile:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update profile',
            error: error.message
        });
    }
});

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper function to convert data limit string to bytes
function parseDataLimit(limit) {
    if (!limit || limit === '') return '';
    
    // Remove any whitespace and convert to uppercase
    const cleanLimit = limit.toString().trim().toUpperCase();
    
    // If it's just a number, treat it as MB
    if (!isNaN(cleanLimit)) {
        return Math.floor(parseFloat(cleanLimit) * 1048576).toString();
    }
    
    const match = cleanLimit.match(/^(\d+\.?\d*)(K|M|G|T)?B?$/);
    if (!match) return '';
    
    const value = parseFloat(match[1]);
    const unit = match[2] || 'M'; // Default to MB if no unit specified
    
    switch (unit) {
        case 'K': return Math.floor(value * 1024).toString();
        case 'M': return Math.floor(value * 1048576).toString();
        case 'G': return Math.floor(value * 1073741824).toString();
        case 'T': return Math.floor(value * 1099511627776).toString();
        default: return Math.floor(value * 1048576).toString(); // Default to MB
    }
}

// Helper function to format data limit for display
function formatDataLimit(bytes) {
    if (!bytes || bytes === '') return 'unlimited';
    
    const value = parseInt(bytes);
    if (value >= 1099511627776) return `${(value / 1099511627776).toFixed(2)}TB`;
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)}GB`;
    if (value >= 1048576) return `${(value / 1048576).toFixed(2)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`;
    return `${value}B`;
}

// ENDPOINT: Generate hotspot vouchers in bulk
app.post('/api/router/:connectionId/hotspot-vouchers', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        const {
            count = 1,
            profile = "default",
            server = "all",
            timeLimit = "",
            dataLimit = "",  // Now in MB
            nameLength = 5,
            charset = "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ",
            characters = "mixed",
            comment = "",
            prefixUsername = "vc-",
            userMode = "different",
            limitUptime,
            limitBytesTotal,  // Now in MB
            batchName = "Batch-" + new Date().toISOString().slice(0, 10)
        } = req.body;

        // Validate required fields
        if (!profile) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: profile'
            });
        }

        // Define character sets for different patterns
        const characterSets = {
            lowercase_numbers: {
                letters: "abcdefghijklmnopqrstuvwxyz",
                numbers: "0123456789"
            },
            uppercase_numbers: {
                letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                numbers: "0123456789"
            },
            mixed_numbers: {
                letters: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
                numbers: "0123456789"
            },
            numbers_only: {
                numbers: "0123456789"
            }
        };

        // Helper function to generate string with specific pattern
        function generatePatternString(length, pattern) {
            const set = characterSets[pattern] || characterSets.mixed_numbers;
            
            if (pattern === "numbers_only") {
                return generateRandomString(length, set.numbers);
            }
            
            // For other patterns, split length between letters and numbers
            const letterLength = Math.ceil(length * 0.6); // 60% letters
            const numberLength = length - letterLength; // 40% numbers
            
            const letters = generateRandomString(letterLength, set.letters);
            const numbers = generateRandomString(numberLength, set.numbers);
            
            // Combine and shuffle the string
            const combined = letters + numbers;
            return shuffleString(combined);
        }

        // Helper function to shuffle a string
        function shuffleString(str) {
            const array = str.split('');
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(crypto.randomBytes(1)[0] / 256 * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
            return array.join('');
        }

        // Validate count
        const voucherCount = parseInt(count);
        if (isNaN(voucherCount) || voucherCount < 1) {
            return res.status(400).json({
                success: false,
                message: 'Invalid count value. Must be a positive number.'
            });
        }

        // Limit the maximum number of vouchers per request to prevent abuse
        const maxVouchersPerRequest = 100;
        if (voucherCount > maxVouchersPerRequest) {
            return res.status(400).json({
                success: false,
                message: `Cannot generate more than ${maxVouchersPerRequest} vouchers in a single request`
            });
        }

        // Get router info for formatting
        const router = await getRouterById(connectionId);
        const currency = router?.currency || 'LRD';

        // Look up profile to get pricing info BEFORE generating vouchers
        let profilePrice = '0';
        let profileSellingPrice = '0';
        
        try {
            const profileInfo = await getHotspotProfile(parseInt(connectionId), profile);
            if (profileInfo) {
                profilePrice = profileInfo.price;
                profileSellingPrice = profileInfo.selling_price;
            } else {
                // If profile not found in database, try to fetch from MikroTik
                const mikrotikProfiles = await connection.write('/ip/hotspot/user/profile/print', [
                    '?name=' + profile
                ]);
                
                if (mikrotikProfiles && mikrotikProfiles.length > 0) {
                    // Store profile in database if found in MikroTik
                    const mikrotikProfile = mikrotikProfiles[0];
                    const profileData = {
                        router_id: parseInt(connectionId),
                        name: profile,
                        shared_users: mikrotikProfile['shared-users'] || '1',
                        rate_limit: mikrotikProfile['rate-limit'] || 'unlimited',
                        validity: '',  // Extract from on-login if needed
                        user_lock: mikrotikProfile['address-list'] ? 'yes' : 'no',
                        server_lock: mikrotikProfile.server ? 'yes' : 'no',
                        expire_mode: "Remove & Record",
                        price: '0',  // Default price
                        selling_price: '0',  // Default selling price
                        session_timeout: mikrotikProfile['session-timeout'] || '',
                        idle_timeout: mikrotikProfile['idle-timeout'] || 'none',
                        keepalive_timeout: mikrotikProfile['keepalive-timeout'] || '2m',
                        status_autorefresh: mikrotikProfile['status-autorefresh'] || '1m',
                        mac_cookie_timeout: mikrotikProfile['mac-cookie-timeout'] || '3d',
                        mikrotik_profile: 1
                    };
                    
                    await upsertHotspotProfile(profileData);
                    
                    // Return error since price info is required
                    return res.status(400).json({
                        success: false,
                        message: 'Profile found but price information is not set. Please set price and selling price for the profile first.'
                    });
                } else {
                    return res.status(404).json({
                        success: false,
                        message: `Profile "${profile}" not found`
                    });
                }
            }
            
            // Validate that profile has price information
            if (!profilePrice || !profileSellingPrice || profilePrice === '0' || profileSellingPrice === '0') {
                return res.status(400).json({
                    success: false,
                    message: 'Profile price or selling price not set. Please set both prices for the profile first.'
                });
            }
        } catch (profileError) {
            console.error('Error fetching profile price info:', profileError);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch profile price information',
                error: profileError.message
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Generating ${voucherCount} hotspot vouchers with profile: ${profile} (Price: ${profilePrice} ${currency}, Selling: ${profileSellingPrice} ${currency})`,
            'info'
        );

        // Prepare to collect generated vouchers
        const vouchers = [];
        const crypto = require('crypto');

        // Helper function to generate random string
        function generateRandomString(length, characterSet) {
            let result = '';
            const charactersLength = characterSet.length;
            
            // Use crypto for more secure randomness
            const randomBytes = crypto.randomBytes(length);
            for (let i = 0; i < length; i++) {
                result += characterSet.charAt(randomBytes[i] % charactersLength);
            }
            
            return result;
        }

        // Generate specified number of vouchers
        for (let i = 0; i < voucherCount; i++) {
            let username, password;
            
            if (userMode === "same") {
                // For same mode, generate one value and use it for both username and password
                // Ignore prefix in this case
                const value = generatePatternString(nameLength, characters);
                username = value;
                password = value;
            } else {
                // For different mode, use prefix for username and generate separate password
                const usernameWithoutPrefix = generatePatternString(nameLength, characters);
                username = prefixUsername + usernameWithoutPrefix;
                password = generatePatternString(nameLength, characters);  // Use same length as username
            }

            // Prepare command parameters
            const params = [
                '=name=' + username,
                '=password=' + password,
                '=profile=' + profile,
            ];
            
            // Add optional parameters
            if (server && server !== "all") {
                params.push('=server=' + server);
            }
            
            // Handle time limit (use timeLimit or limitUptime)
            const effectiveTimeLimit = timeLimit || limitUptime || "";
            if (effectiveTimeLimit) {
                params.push('=limit-uptime=' + effectiveTimeLimit);
            }
            
            // Handle data limit (use dataLimit or limitBytesTotal)
            const effectiveDataLimit = dataLimit || limitBytesTotal || "";
            if (effectiveDataLimit) {
                const dataLimitBytes = parseDataLimit(effectiveDataLimit);
                if (dataLimitBytes) {
                    params.push('=limit-bytes-total=' + dataLimitBytes);
                }
            }
            
            // Add comment (combine provided comment with batch name)
            const effectiveComment = comment ? 
                `${comment} | ${batchName}` : 
                batchName;
            
            params.push('=comment=' + effectiveComment);
            
            // Create the user (voucher)
            await connection.write('/ip/hotspot/user/add', params);
            
            // Store created voucher info
            vouchers.push({
                username,
                password,
                profile,
                timeLimit: effectiveTimeLimit || 'unlimited',
                dataLimit: effectiveDataLimit ? 
                    formatDataLimit(parseDataLimit(effectiveDataLimit)) : 
                    'unlimited',
                comment: effectiveComment,
                created: new Date().toISOString()
            });
        }

        // Store vouchers in database if needed
        // This is optional but useful for record keeping
        if (db.storeVouchers) {
            try {
                await db.storeVouchers(connectionId, vouchers, batchName);
            } catch (dbError) {
                console.error('Error storing vouchers in database:', dbError);
                // Continue anyway, this is not critical
            }
        }

        // Log success
        createLogEntry(
            connectionId,
            `Successfully generated ${voucherCount} hotspot vouchers`,
            'success',
            { 
                profile,
                count: voucherCount,
                batchName
            }
        );

        res.json({
            success: true,
            message: `Generated ${voucherCount} vouchers successfully`,
            data: {
                count: voucherCount,
                profile,
                batchName,
                timeLimit: timeLimit || limitUptime || 'unlimited',
                price: profilePrice,
                sellingPrice: profileSellingPrice,
                currency,
                vouchers
            }
        });
        
    } catch (error) {
        console.error('Error generating vouchers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate vouchers',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Get hotspot servers list
app.get('/api/router/:connectionId/hotspot-servers', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Hotspot servers list requested',
            'info'
        );
        
        // Get all hotspot servers
        const servers = await connection.write('/ip/hotspot/print');
        
        // Format the response
        const formattedServers = servers.map(server => ({
            name: server.name || 'all',
            interface: server.interface || '',
            profile: server['profile'] || 'default',
            addresses: server['addresses-pool'] || '',
            disabled: server.disabled === 'true',
            invalidUsername: server['invalid-username'] || 'password',
            addressPool: server['address-pool'] || '',
            ipOfDnsName: server['ip-of-dns-name'] || '',
            htmlDirectory: server['html-directory'] || 'hotspot',
            htmlSubdir: server['html-subdir'] || '',
            loginBy: server['login-by'] || 'http-chap,http-pap,cookie,mac-cookie',
            macFormat: server['mac-format'] || '',
            macCookieTimeout: server['mac-cookie-timeout'] || '3d',
            cookieLifetime: server['cookie-lifetime'] || '3d'
        }));

        res.json({
            success: true,
            data: {
                total: formattedServers.length,
                servers: formattedServers
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot servers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch hotspot servers',
            error: error.message
        });
    }
});

// FINAL ENDPOINT: Get DNS name from hotspot profiles
app.get('/api/router/:connectionId/hotspot-dns-name', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            'Hotspot DNS name requested',
            'info'
        );
        
        // Get all hotspot profiles
        const profiles = await connection.write('/ip/hotspot/profile/print');
        
        if (profiles.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No hotspot profiles found'
            });
        }
        
        // Find the first profile with a non-empty DNS name
        let dnsName = '';
        let profileName = '';
        
        for (const profile of profiles) {
            if (profile['dns-name'] && profile['dns-name'].trim() !== '') {
                dnsName = profile['dns-name'];
                profileName = profile.name || '';
                break;
            }
        }
        
        res.json({
            success: true,
            data: {
                dnsName: dnsName
            }
        });
        
    } catch (error) {
        console.error('Error fetching hotspot DNS name:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch hotspot DNS name',
            error: error.message
        });
    }
});

// EDIT ENDPOINT: Edit existing hotspot user
app.put('/api/router/:connectionId/hotspot-users/:username', async (req, res) => {
    try {
        const { connectionId, username } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get the user's current details first
        const existingUsers = await connection.write('/ip/hotspot/user/print', [
            '?name=' + username
        ]);

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const existingUser = existingUsers[0];
        const userId = existingUser['.id'];

        const {
            server,
            password,
            macAddress,
            profile,
            timeLimit,
            dataLimit,
            comment,
            limitUpTime,
            limitBitesTotal,
            userCode,
            expireDate
        } = req.body;

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Editing hotspot user: ${username}`,
            'info'
        );

        // Prepare command parameters
        const params = ['=.id=' + userId];

        // Only add parameters that are provided in the request
        if (password) params.push('=password=' + password);
        if (profile) params.push('=profile=' + profile);
        if (server) {
            // If server is 'all', don't add the server parameter at all
            if (server !== 'all') {
                params.push('=server=' + server);
            }
        }
        if (macAddress !== undefined && macAddress !== null) {
            // Only add MAC address if it's a non-empty string
            if (macAddress.trim() !== '') {
                params.push('=mac-address=' + macAddress);
            }
        }
        if (timeLimit !== undefined) {
            // Set to '0s' (unlimited) if empty string, otherwise use provided value
            params.push('=limit-uptime=' + (timeLimit.trim() === '' ? '0s' : timeLimit));
        }
        if (dataLimit !== undefined) {
            // Set to '0' (unlimited) if empty string, otherwise use provided value
            params.push('=limit-bytes-total=' + (dataLimit.trim() === '' ? '0' : dataLimit));
        }
        if (comment !== undefined) params.push('=comment=' + (comment || ''));
        if (limitUpTime !== undefined) params.push('=limit-uptime=' + (limitUpTime || ''));
        if (limitBitesTotal !== undefined) params.push('=limit-bytes-total=' + (limitBitesTotal || ''));
        if (userCode !== undefined) params.push('=user-code=' + (userCode || ''));
        if (expireDate !== undefined) params.push('=expire-date=' + (expireDate || ''));

        // Update the user
        await connection.write('/ip/hotspot/user/set', params);

        // Log success
        createLogEntry(
            connectionId,
            `Successfully updated hotspot user: ${username}`,
            'success',
            { profile, server }
        );

        // Get the updated user's details
        const updatedUsers = await connection.write('/ip/hotspot/user/print', [
            '?name=' + username
        ]);

        const updatedUser = updatedUsers[0];

        res.json({
            success: true,
            message: 'User updated successfully',
            data: {
                name: updatedUser.name,
                profile: updatedUser.profile,
                server: updatedUser.server || 'all',
                macAddress: updatedUser['mac-address'] || '',
                limitUptime: updatedUser['limit-uptime'] || '',
                limitBytesTotal: updatedUser['limit-bytes-total'] || '',
                comment: updatedUser.comment || ''
            }
        });
        
    } catch (error) {
        console.error('Error updating hotspot user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Delete hotspot user
app.delete('/api/router/:connectionId/hotspot-users/:username', async (req, res) => {
    try {
        const { connectionId, username } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get the user's details first to verify existence and get the ID
        const existingUsers = await connection.write('/ip/hotspot/user/print', [
            '?name=' + username
        ]);

        if (!existingUsers || existingUsers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const userId = existingUsers[0]['.id'];

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Deleting hotspot user: ${username}`,
            'info'
        );

        // Delete the user
        await connection.write('/ip/hotspot/user/remove', [
            '=numbers=' + userId
        ]);

        // Log success
        createLogEntry(
            connectionId,
            `Successfully deleted hotspot user: ${username}`,
            'success',
            { 
                profile: existingUsers[0].profile,
                server: existingUsers[0].server || 'all'
            }
        );

        res.json({
            success: true,
            message: 'User deleted successfully',
            data: {
                username: username,
                profile: existingUsers[0].profile,
                server: existingUsers[0].server || 'all'
            }
        });
        
    } catch (error) {
        console.error('Error deleting hotspot user:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete user',
            error: error.message
        });
    }
});

// NEW ENDPOINT: Track voucher usage for financial transactions
app.get('/api/router/:connectionId/voucher-transactions', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const { startDate, endDate, batchName } = req.query;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Validate date parameters
        let startDateTime = startDate ? new Date(startDate) : null;
        let endDateTime = endDate ? new Date(endDate) : null;
        
        if ((startDate && isNaN(startDateTime)) || (endDate && isNaN(endDateTime))) {
            return res.status(400).json({
                success: false,
                message: 'Invalid date format. Please use YYYY-MM-DD format.'
            });
        }

        // Create log entry for this request
        createLogEntry(
            connectionId,
            `Voucher transactions requested${batchName ? ` for batch ${batchName}` : ''}${startDate ? ` from ${startDate}` : ''}${endDate ? ` to ${endDate}` : ''}`,
            'info'
        );
        
        // Get hotspot logs with date filtering if specified
        const logs = await connection.write('/log/print');
        
        // Get router info for currency
        const router = await getRouterById(connectionId);
        const currency = router?.currency || 'LRD';
        
        // Filter logs for successful logins with date range
        const loginLogs = logs
            .filter(log => {
                const message = log.message || '';
                const isLogin = message.includes('logged in') && !message.includes('failed');
                
                if (!isLogin) return false;
                
                // Apply date filtering if specified
                if (startDateTime || endDateTime) {
                    const logDate = new Date(`${parseRouterDate(log.date)} ${log.time || '00:00:00'}`);
                    if (startDateTime && logDate < startDateTime) return false;
                    if (endDateTime && logDate > endDateTime) return false;
                }
                
                return true;
            })
            .map(log => {
                // Extract username from message
                let username = '';
                const message = log.message || '';
                
                // Different patterns for extracting username
                const userPatternDirect = /user\s+(\S+)\s+logged/i;
                const userPatternHotspot = /->:\s+([^(]+)\s*\(/i;
                
                const userMatchDirect = message.match(userPatternDirect);
                const userMatchHotspot = message.match(userPatternHotspot);
                
                if (userMatchDirect) {
                    username = userMatchDirect[1];
                } else if (userMatchHotspot) {
                    username = userMatchHotspot[1].trim();
                }
                
                // Extract IP address with validation
                let ip = '';
                const ipMatch = message.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
                if (ipMatch && ipMatch[0].split('.').every(num => parseInt(num) <= 255)) {
                    ip = ipMatch[0];
                }
                
                // For MAC addresses with validation
                let mac = '';
                const macMatch = message.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/i);
                if (macMatch) {
                    mac = macMatch[0].toUpperCase();
                }

                const parsedDate = parseRouterDate(log.date);
                
                return {
                    username,
                    ip,
                    mac,
                    time: log.time || '00:00:00',
                    date: parsedDate,
                    timestamp: new Date(`${parsedDate}T${log.time || '00:00:00'}`).getTime(),
                    message
                };
            });
        
        // Get all hotspot users that are vouchers
        const users = await connection.write('/ip/hotspot/user/print');
        
        // Filter users that have batch info in comments
        const vouchers = users.filter(user => {
            // Filter by specific batch if provided
            if (batchName && user.comment && !user.comment.includes(batchName)) {
                return false;
            }
            
            // Check for batch identifier in comment
            return user.comment && (
                user.comment.includes('Batch-') || 
                user.name.startsWith('vc-')
            );
        });
        
        // Track transactions with improved error handling
        const transactions = [];
        const errors = [];
        
        for (const voucher of vouchers) {
            try {
                // Look for login events for this voucher
                const voucherLogins = loginLogs
                    .filter(log => log.username === voucher.name)
                    .sort((a, b) => a.timestamp - b.timestamp);
                
                // Get the first login if available
                const firstLogin = voucherLogins[0];
                
                if (firstLogin) {
                    // Extract batch name and profile from comment
                    let batchName = 'Unknown';
                    const batchMatch = voucher.comment ? voucher.comment.match(/Batch-[^|\s]+/) : null;
                    if (batchMatch) {
                        batchName = batchMatch[0];
                    }
                    
                    // Get price from profile with error handling
                    let price = '0';
                    let profileInfo = null;
                    try {
                        profileInfo = await getHotspotProfile(parseInt(connectionId), voucher.profile);
                        if (profileInfo) {
                            price = profileInfo.selling_price;
                        }
                    } catch (profileError) {
                        errors.push(`Error fetching profile price for ${voucher.name}: ${profileError.message}`);
                    }
                    
                    // Calculate usage statistics
                    const lastLogin = voucherLogins[voucherLogins.length - 1] || firstLogin;
                    const usageDuration = Math.max(0, Math.floor((lastLogin.timestamp - firstLogin.timestamp) / 1000));
                    
                    transactions.push({
                        voucherName: voucher.name,
                        profile: voucher.profile,
                        batchName,
                        firstLoginDate: firstLogin.date || new Date().toISOString().split('T')[0],
                        firstLoginTime: firstLogin.time || '00:00:00',
                        lastLoginDate: lastLogin.date || firstLogin.date || new Date().toISOString().split('T')[0],
                        lastLoginTime: lastLogin.time || firstLogin.time || '00:00:00',
                        ipAddress: firstLogin.ip || '',
                        macAddress: firstLogin.mac || '',
                        price: `${price} ${currency}`,
                        rawPrice: parseFloat(price) || 0,
                        comment: voucher.comment || '',
                        limitUptime: voucher['limit-uptime'] || '',
                        loginCount: voucherLogins.length || 1,
                        usageDurationSeconds: usageDuration,
                        usageDurationFormatted: formatUptime(usageDuration)
                    });
                }
            } catch (voucherError) {
                errors.push(`Error processing voucher ${voucher.name}: ${voucherError.message}`);
            }
        }
        
        // Calculate statistics with improved date handling
        const totalRevenue = transactions.reduce((sum, t) => sum + t.rawPrice, 0);
        const averageRevenue = transactions.length ? totalRevenue / transactions.length : 0;
        const averageLogins = transactions.length ? 
            transactions.reduce((sum, t) => sum + t.loginCount, 0) / transactions.length : 0;

        // Calculate today's revenue with proper date comparison
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to start of day

        const todayRevenue = transactions
            .filter(t => {
                const loginDate = new Date(t.firstLoginDate);
                loginDate.setHours(0, 0, 0, 0);
                return loginDate.getTime() === today.getTime();
            })
            .reduce((sum, t) => sum + t.rawPrice, 0);

        // Calculate this month's revenue with proper date comparison
        const currentDate = new Date();
        const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

        const thisMonthRevenue = transactions
            .filter(t => {
                const loginDate = new Date(t.firstLoginDate);
                return loginDate >= firstDayOfMonth && loginDate <= lastDayOfMonth;
            })
            .reduce((sum, t) => sum + t.rawPrice, 0);

        // Calculate revenue by date for the last 7 days
        const last7Days = Array.from({ length: 7 }, (_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - i);
            date.setHours(0, 0, 0, 0);
            return date;
        });

        const dailyRevenue = last7Days.map(date => {
            const dayRevenue = transactions
                .filter(t => {
                    const loginDate = new Date(t.firstLoginDate);
                    loginDate.setHours(0, 0, 0, 0);
                    return loginDate.getTime() === date.getTime();
                })
                .reduce((sum, t) => sum + t.rawPrice, 0);

            return {
                date: date.toISOString().split('T')[0],
                revenue: dayRevenue
            };
        });

        // Calculate revenue by month for the last 6 months
        const last6Months = Array.from({ length: 6 }, (_, i) => {
            const date = new Date();
            date.setMonth(date.getMonth() - i);
            return new Date(date.getFullYear(), date.getMonth(), 1);
        });

        const monthlyRevenue = last6Months.map(monthStart => {
            const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
            const monthRevenue = transactions
                .filter(t => {
                    const loginDate = new Date(t.firstLoginDate);
                    return loginDate >= monthStart && loginDate <= monthEnd;
                })
                .reduce((sum, t) => sum + t.rawPrice, 0);

            return {
                month: monthStart.toISOString().split('T')[0].substring(0, 7), // YYYY-MM format
                revenue: monthRevenue
            };
        });

        res.json({
            success: true,
            data: {
                currency,
                total: transactions.length,
                totalRevenue,
                todayRevenue,
                thisMonthRevenue,
                averageRevenue,
                averageLoginsPerVoucher: averageLogins,
                dateRange: {
                    start: startDate || 'all time',
                    end: endDate || 'present',
                    currentMonth: `${firstDayOfMonth.toISOString().split('T')[0]} to ${lastDayOfMonth.toISOString().split('T')[0]}`
                },
                revenueStats: {
                    daily: dailyRevenue,
                    monthly: monthlyRevenue
                },
                transactions,
                errors: errors.length ? errors : undefined
            }
        });
        
    } catch (error) {
        console.error('Error tracking voucher transactions:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// Add this function near other formatting functions
function formatUptime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    
    const days = Math.floor(seconds / (24 * 60 * 60));
    seconds = seconds % (24 * 60 * 60);
    const hours = Math.floor(seconds / (60 * 60));
    seconds = seconds % (60 * 60);
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);

    return parts.join(' ');
}

// Add this helper function for date handling
function parseRouterDate(time, defaultDate = null) {
    // MikroTik router logs use 'mmm/dd/yyyy' format
    const months = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };

    if (!time) return defaultDate || new Date().toISOString().split('T')[0];

    // Handle cases where we have only time
    if (!time.includes('/')) {
        return new Date().toISOString().split('T')[0];
    }

    // Parse router date format
    const [month, day, year] = time.toLowerCase().split('/');
    const monthNum = months[month.substring(0, 3)];
    
    if (!monthNum || !day || !year) {
        return defaultDate || new Date().toISOString().split('T')[0];
    }

    return `${year}-${monthNum}-${day.padStart(2, '0')}`;
}

// Get hotspot host information
app.get('/api/router/:connectionId/hotspot-hosts', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Get all hotspot hosts
        const hosts = await connection.write('/ip/hotspot/host/print');
        
        // Format the response data
        const formattedHosts = hosts.map(host => ({
            macAddress: host['mac-address'] || '',
            address: host.address || '',
            toAddress: host['to-address'] || '',
            server: host.server || '',
            rxRate: formatBitrate(host['rx-rate'] || 0),
            txRate: formatBitrate(host['tx-rate'] || 0),
            uptime: formatUptime(host.uptime || 0),
            keepaliveTimeout: host['keepalive-timeout'] || '',
            bytesIn: formatBytes(host['bytes-in'] || 0),
            bytesOut: formatBytes(host['bytes-out'] || 0),
            loginBy: host['login-by'] || '',
            comment: host.comment || ''
        }));

        res.json({
            success: true,
            message: 'Successfully retrieved hotspot hosts',
            data: {
                hosts: formattedHosts
            }
        });

    } catch (error) {
        console.error('Error fetching hotspot hosts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch hotspot hosts',
            error: error.message
        });
    }
});

// Clear voucher database
app.post('/api/router/:connectionId/clear-vouchers', async (req, res) => {
    try {
        const { connectionId } = req.params;
        const connection = connections.get(connectionId);
        
        if (!connection) {
            return res.status(404).json({
                success: false,
                message: 'Connection not found or disconnected'
            });
        }

        // Create log entry for this action
        createLogEntry(
            connectionId,
            'Clearing all voucher data',
            'warning'
        );

        // Get all hotspot users
        const users = await connection.write('/ip/hotspot/user/print');
        
        // Filter voucher users (those with batch info in comments or vc- prefix)
        const voucherUsers = users.filter(user => 
            (user.comment && user.comment.includes('Batch-')) || 
            user.name.startsWith('vc-')
        );

        // Remove each voucher user
        let removedCount = 0;
        const errors = [];

        for (const user of voucherUsers) {
            try {
                await connection.write('/ip/hotspot/user/remove', [
                    '=numbers=' + user['.id']
                ]);
                removedCount++;
            } catch (error) {
                errors.push(`Failed to remove user ${user.name}: ${error.message}`);
            }
        }

        // Clear active sessions for removed users
        try {
            const activeSessions = await connection.write('/ip/hotspot/active/print');
            for (const session of activeSessions) {
                if (voucherUsers.some(user => user.name === session.user)) {
                    await connection.write('/ip/hotspot/active/remove', [
                        '=numbers=' + session['.id']
                    ]);
                }
            }
        } catch (error) {
            errors.push(`Failed to clear active sessions: ${error.message}`);
        }

        // Clear local database voucher records if they exist
        try {
            await db.clearVoucherRecords(connectionId);
        } catch (error) {
            errors.push(`Failed to clear local voucher records: ${error.message}`);
        }

        res.json({
            success: true,
            message: 'Voucher database cleared successfully',
            data: {
                removedVouchers: removedCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (error) {
        console.error('Error clearing voucher database:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear voucher database',
            error: error.message
        });
    }
});  

// Update hotspot user
app.post('/api/hotspot/users/update', async (req, res) => {
    try {
        const { routerId, userData } = req.body;
        
        const result = await db.one(`
            INSERT INTO hotspot_users (
                router_id, username, profile, server, mac_address,
                last_uptime, last_bytes_in, last_bytes_out, comment,
                last_seen
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            ON CONFLICT (router_id, username) DO UPDATE SET
                profile = EXCLUDED.profile,
                server = EXCLUDED.server,
                mac_address = EXCLUDED.mac_address,
                last_uptime = EXCLUDED.last_uptime,
                last_bytes_in = EXCLUDED.last_bytes_in,
                last_bytes_out = EXCLUDED.last_bytes_out,
                comment = EXCLUDED.comment,
                last_seen = CURRENT_TIMESTAMP
            RETURNING *
        `, [
            routerId,
            userData.Name,
            userData.Profile,
            userData.Server,
            userData.MacAddress,
            userData.Uptime,
            userData.BytesIn,
            userData.BytesOut,
            userData.Comment
        ]);

        res.json({ success: true, user: result });
    } catch (error) {
        console.error('Error updating hotspot user:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get stored user data
app.get('/api/hotspot/users/:routerId/:username', async (req, res) => {
    try {
        const user = await db.oneOrNone(
            'SELECT * FROM hotspot_users WHERE router_id = $1 AND username = $2',
            [req.params.routerId, req.params.username]
        );
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({ success: true, user });
    } catch (error) {
        console.error('Error getting hotspot user:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get all stored users for a router
app.get('/api/hotspot/users/:routerId', async (req, res) => {
    try {
        const users = await db.any(
            'SELECT * FROM hotspot_users WHERE router_id = $1 ORDER BY last_seen DESC',
            [req.params.routerId]
        );
        res.json({ success: true, users });
    } catch (error) {
        console.error('Error getting hotspot users:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Store financial transaction
app.post('/api/transactions', async (req, res) => {
    try {
        const transaction = await db.one(`
            INSERT INTO financial_transactions (
                router_id, voucher_name, batch_name, profile,
                amount, currency, transaction_date, transaction_type,
                ip_address, mac_address, login_count, usage_duration, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            req.body.routerId,
            req.body.voucherName,
            req.body.batchName,
            req.body.profile,
            req.body.amount,
            req.body.currency,
            req.body.transactionDate,
            req.body.transactionType || 'VOUCHER_USAGE',
            req.body.ipAddress,
            req.body.macAddress,
            req.body.loginCount || 1,
            req.body.usageDuration,
            req.body.status || 'COMPLETED'
        ]);

        res.json({ success: true, transaction });
    } catch (error) {
        console.error('Error storing transaction:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get router transactions
app.get('/api/transactions/:routerId', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let query = 'SELECT * FROM financial_transactions WHERE router_id = $1';
        const params = [req.params.routerId];

        if (startDate) {
            query += ' AND transaction_date >= $2';
            params.push(startDate);
        }
        if (endDate) {
            query += ' AND transaction_date <= $' + (params.length + 1);
            params.push(endDate);
        }

        query += ' ORDER BY transaction_date DESC';
        
        const transactions = await db.any(query, params);
        res.json({ success: true, transactions });
    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});


app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Update the IP address detection logic
app.get('/api/ip', async (req, res) => {
    try {
        const clientIp = isDevelopment ? '127.0.0.1' : req.ip;
        res.json({
            success: true,
            ip: clientIp,
            environment: isDevelopment ? 'development' : 'production'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to get IP address',
            error: error.message,
            environment: isDevelopment ? 'development' : 'production'
        });
    }
});
