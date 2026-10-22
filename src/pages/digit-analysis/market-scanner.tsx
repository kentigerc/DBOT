import { useCallback, useEffect, useRef, useState } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { lastDigit } from './digits';
import { evaluateScan, scanDigits, ScanSide } from './scanner';

type Market = { symbol: string; display_name: string };
type Api = Awaited<ReturnType<typeof generateDerivApiInstance>>;
type Result = Market & ReturnType<typeof evaluateScan>;

export default function MarketScanner({
    sampleSize,
    onSelect,
}: {
    sampleSize: number;
    onSelect: (symbol: string) => void;
}) {
    const [side, setSide] = useState<ScanSide>('over');
    const [running, setRunning] = useState(false);
    const [message, setMessage] = useState('Choose a contract type and scan the Volatility markets.');
    const [results, setResults] = useState<Result[]>([]);
    const [scannedAt, setScannedAt] = useState('');
    const generation = useRef(0);
    const connection = useRef<Api>();
    const stop = useCallback(() => {
        generation.current++;
        connection.current?.disconnect();
        connection.current = undefined;
    }, []);
    useEffect(() => {
        stop();
        setRunning(false);
        setResults([]);
        setScannedAt('');
        setMessage('Choose a contract type and scan the Volatility markets.');
        return stop;
    }, [side, sampleSize, stop]); // Cancel stale requests before settings change or unmount.
    const scan = async () => {
        stop();
        const current = generation.current;
        const found: Result[] = [];
        let completed = 0;
        let failed = 0;
        setRunning(true);
        setResults([]);
        setScannedAt('');
        setMessage('Connecting to market data…');
        const request = async (payload: Parameters<Api['send']>[0]) => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    connection.current!.send(payload),
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('Market data request timed out.')), 15000);
                    }),
                ]);
            } finally {
                clearTimeout(timeout);
            }
        };
        try {
            const api = await generateDerivApiInstance({ publicOnly: true });
            if (current !== generation.current) {
                api.disconnect();
                return;
            }
            connection.current = api;
            const response = await request({ active_symbols: 'brief' });
            if (current !== generation.current) return;
            const markets: Market[] = (response.active_symbols || []).filter(
                (market: Market & { exchange_is_open: number; is_trading_suspended: number }) =>
                    /^(R_\d+|1HZ\d+V)$/.test(market.symbol) && market.exchange_is_open && !market.is_trading_suspended
            );
            if (!markets.length) throw new Error('No available Volatility markets. Please try again.');
            // Sequential snapshots avoid flooding the public API with subscriptions.
            for (const market of markets) {
                if (current !== generation.current) return;
                setMessage(`Scanning ${completed + 1}/${markets.length}: ${market.display_name}`);
                try {
                    const history = await request({
                        ticks_history: market.symbol,
                        style: 'ticks',
                        end: 'latest',
                        count: sampleSize,
                    });
                    if (current !== generation.current) return;
                    if (!Array.isArray(history.history?.prices) || !Number.isInteger(history.pip_size))
                        throw new Error('Missing history');
                    const digits = (history.history.prices as number[])
                        .map(price => lastDigit(price, history.pip_size))
                        .filter((digit): digit is number => digit !== null)
                        .slice(-sampleSize);
                    if (digits.length !== sampleSize) throw new Error('Incomplete history');
                    const evaluation = evaluateScan(digits, side, sampleSize);
                    if (evaluation.matches) found.push({ ...market, ...evaluation });
                } catch {
                    failed++;
                }
                completed++;
            }
            if (current !== generation.current) return;
            setResults(found);
            setScannedAt(new Date().toLocaleTimeString());
            setMessage(
                `${found.length} matching ${found.length === 1 ? 'market' : 'markets'} · ${completed - failed}/${markets.length} checked${failed ? ` · ${failed} unavailable (retry scan)` : ''}`
            );
        } catch (error) {
            if (current === generation.current)
                setMessage(error instanceof Error ? error.message : 'Unable to scan. Please try again.');
        } finally {
            if (current === generation.current) {
                connection.current?.disconnect();
                connection.current = undefined;
                setRunning(false);
            }
        }
    };
    return (
        <section className='digit-scanner' aria-labelledby='digit-scanner-title'>
            <h2 id='digit-scanner-title'>Over / Under market scanner</h2>
            <p>Find markets matching your digit conditions in the last {sampleSize.toLocaleString()} ticks.</p>
            <div className='digit-scanner__controls'>
                <label>
                    Contract type
                    <select value={side} onChange={event => setSide(event.target.value as ScanSide)}>
                        <option value='over'>Over</option>
                        <option value='under'>Under</option>
                    </select>
                </label>
                <button onClick={() => void scan()} disabled={running}>
                    SCAN
                </button>
                {running && (
                    <button
                        onClick={() => {
                            stop();
                            setRunning(false);
                            setMessage('Scan cancelled.');
                        }}
                    >
                        CANCEL
                    </button>
                )}
            </div>
            <p className='digit-scanner__rules'>
                Digits {scanDigits(side).join(', ')}: each below 10%. Red (least frequent) must be in this group; green
                (most frequent) must be in {scanDigits(side === 'over' ? 'under' : 'over').join(', ')}. All tied marks
                must stay within their required group.
            </p>
            <p role='status' aria-live='polite'>
                {message}
            </p>
            {scannedAt && <p>Snapshot at {scannedAt}. Rescan to refresh; conditions may change.</p>}
            <div className='digit-scanner__results'>
                {results.map(result => (
                    <article key={result.symbol}>
                        <h3>{result.display_name}</h3>
                        <p>{result.selected.map(item => `${item.digit}: ${item.percent.toFixed(2)}%`).join(' · ')}</p>
                        <p>
                            Red: {result.redDigits.join(', ')} · Green: {result.greenDigits.join(', ')}
                        </p>
                        <button onClick={() => onSelect(result.symbol)}>View digits</button>
                    </article>
                ))}
            </div>
            <p>These are historical matches, not predictions or trading guarantees.</p>
        </section>
    );
}
