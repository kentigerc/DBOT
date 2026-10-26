const fs = require('node:fs');
const path = require('node:path');

function createAnalyticsStore({
    databaseUrl = process.env.DATABASE_URL,
    directory = process.env.NETO_ANALYTICS_DIR || path.join(__dirname, '../.analytics-state'),
} = {}) {
    let failure = false;
    let pool;
    let ready;
    let records;
    let unreadable = false;
    if (databaseUrl) {
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString: databaseUrl,
            max: 3,
            connectionTimeoutMillis: 5000,
            statement_timeout: 10000,
        });
        ready = null;
    } else {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'events.ndjson');
        try {
            records = new Map(
                fs
                    .readFileSync(file, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map(line => {
                        const event = JSON.parse(line);
                        return [event.id, event];
                    })
            );
        } catch (error) {
            if (error.code !== 'ENOENT') {
                failure = true;
                unreadable = true;
            }
            records = new Map();
        }
        ready = Promise.resolve();
    }
    const ensureReady = async () => {
        if (unreadable) throw new Error('Analytics history could not be read.');
        if (!pool) return;
        if (!ready)
            ready = pool
                .query(
                    'CREATE TABLE IF NOT EXISTS neto_analytics_events (id text PRIMARY KEY, kind text NOT NULL, occurred_at timestamptz NOT NULL, data jsonb NOT NULL)'
                )
                .then(() =>
                    pool.query(
                        'CREATE INDEX IF NOT EXISTS neto_analytics_events_date ON neto_analytics_events (occurred_at)'
                    )
                )
                .catch(error => {
                    ready = null;
                    failure = true;
                    throw error;
                });
        await ready;
    };
    const write = async event => {
        await ensureReady();
        if (pool)
            await pool.query(
                'INSERT INTO neto_analytics_events (id,kind,occurred_at,data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
                [event.id, event.kind, new Date(event.at), event]
            );
        else {
            if (records.has(event.id)) return;
            if (records.size >= 100000) throw new Error('Preview analytics capacity reached. Configure PostgreSQL.');
            await fs.promises.appendFile(path.join(directory, 'events.ndjson'), JSON.stringify(event) + '\n', {
                mode: 0o600,
            });
            records.set(event.id, event);
        }
        failure = false;
    };
    return {
        mode: pool ? 'postgres' : 'preview-file',
        health: () => !failure,
        async put(event) {
            try {
                await write(event);
            } catch {
                failure = true;
                throw new Error('Analytics storage unavailable.');
            }
        },
        async list(from, to) {
            await ensureReady();
            const rows = pool
                ? (
                      await pool.query(
                          'SELECT data FROM neto_analytics_events WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at LIMIT 100001',
                          [new Date(from), new Date(to)]
                      )
                  ).rows.map(row => row.data)
                : [...records.values()].filter(row => row.at >= from && row.at < to).sort((a, b) => a.at - b.at);
            if (rows.length > 100000)
                throw Object.assign(new Error('Choose a shorter date range for this report.'), { status: 400 });
            return rows;
        },
        async prune() {
            if (pool) {
                await ensureReady();
                await pool.query("DELETE FROM neto_analytics_events WHERE occurred_at < NOW() - INTERVAL '366 days'");
            }
        },
        async close() {
            if (pool) await pool.end();
        },
    };
}
module.exports = { createAnalyticsStore };
