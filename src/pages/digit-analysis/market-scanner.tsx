import { validateXmlAutoSettings, type XmlAutoSettings } from '@/utils/xml-auto-settings';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { getDerivAccount } from '@/utils/deriv-session';
import { checkServerAnalysis, isAnalysisTrading } from '@/utils/trading-lock';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { observeVolatilityMarkets } from '@/utils/live-volatility-markets';
import { digitFrequencies } from './digits';
import { evaluateScan, ScanSide } from './scanner';

type Market = { symbol: string; display_name: string; submarket?: string };
type Api = Awaited<ReturnType<typeof generateDerivApiInstance>>;
type Snapshot = Market & ReturnType<typeof evaluateScan> & { checkedAt: number; digits: number[] };
type Result = Snapshot & { side: ScanSide };

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
    });
}

export default function MarketScanner({
    sampleSize,
    onSelect,
    onLoad,
    active = true,
    onAutoStart,
}: {
    sampleSize: number;
    onSelect: (symbol: string) => void;
    onLoad: (
        side: ScanSide,
        symbol: string,
        submarket: string,
        baselineCounts: number[],
        autoGeneration?: number
    ) => boolean;
    active?: boolean;
    onAutoStart?: (settings: XmlAutoSettings) => void;
}) {
    const auto = useSyncExternalStore(xmlScannerCycle.subscribe, xmlScannerCycle.getSnapshot);
    const loadRef = useRef(onLoad);
    loadRef.current = onLoad;
    const scanning = auto.enabled
        ? auto.phase === 'scanning' || (auto.phase === 'waiting' && auto.recoverySearch)
        : active;
    const [draft, setDraft] = useState({
        stake: String(auto.settings.stake),
        stopLoss: String(auto.settings.stopLoss),
        takeProfit: String(auto.settings.takeProfit),
        multiplier: String(auto.settings.multiplier),
    });
    const [enabled, setEnabled] = useState(true);
    const [message, setMessage] = useState('Connecting to market data…');
    const [results, setResults] = useState<Result[]>([]);
    const [preview, setPreview] = useState<Snapshot & { matchedSides: ScanSide[] }>();
    const [loadError, setLoadError] = useState('');
    const [preparing, setPreparing] = useState(false);
    const startAttempt = useRef(0);
    useEffect(
        () => () => {
            startAttempt.current++;
        },
        []
    );
    useEffect(() => {
        setResults([]);
        setPreview(undefined);
        setLoadError('');
    }, [sampleSize]);
    useEffect(() => {
        if (!scanning || !enabled) {
            setMessage('Scanner paused. Displayed percentages are snapshots.');
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        let api: Api | undefined;
        const run = async () => {
            while (!signal.aborted) {
                try {
                    setMessage('Connecting to live Volatility feeds…');
                    api = await generateDerivApiInstance({ publicOnly: true });
                    if (signal.aborted) {
                        api.disconnect();
                        return;
                    }
                    await observeVolatilityMarkets(
                        api,
                        sampleSize,
                        signal,
                        value => {
                            const market = {
                                ...value.market,
                                display_name: value.market.display_name || value.market.symbol,
                            };
                            const { digits, epoch } = value;
                            // Evaluate both directions against the same snapshot and API request.
                            const snapshot = { ...market, digits, checkedAt: Date.now() };
                            const evaluations = (['over', 'under'] as const).map(side => ({
                                ...snapshot,
                                ...evaluateScan(digits, side, sampleSize),
                                side,
                            }));
                            const matches = evaluations.filter(result => result.matches);
                            setPreview({ ...evaluations[0], matchedSides: matches.map(result => result.side) });
                            const automatic = xmlScannerCycle.getSnapshot();
                            if (automatic.enabled && automatic.recoverySearch && automatic.match) {
                                const recovery = evaluations.find(
                                    result => result.side === automatic.match?.side && result.entryReady
                                );
                                if (
                                    recovery &&
                                    Number.isFinite(epoch) &&
                                    xmlScannerCycle.offerRecoveryMarket(
                                        {
                                            symbol: recovery.symbol,
                                            side: recovery.side,
                                            name: automatic.match.name,
                                            submarket: recovery.submarket || 'random_index',
                                            sampleSize,
                                            baselineCounts: digitFrequencies(digits).map(item => item.count),
                                        },
                                        digits,
                                        epoch
                                    )
                                ) {
                                    setResults([recovery]);
                                    return;
                                }
                            }
                            if (automatic.enabled && automatic.phase === 'scanning' && matches.length) {
                                const selected = matches.find(result => result.entryReady) || matches[0];
                                const baselineCounts = digitFrequencies(digits).map(item => item.count);
                                const token = xmlScannerCycle.claim({
                                    symbol: selected.symbol,
                                    side: selected.side,
                                    submarket: selected.submarket || 'random_index',
                                    sampleSize,
                                    baselineCounts,
                                    name: selected.side === 'over' ? 'Over Punisher' : 'Under Punisher',
                                });
                                if (token !== undefined) {
                                    setResults([selected]);
                                    try {
                                        if (
                                            !loadRef.current(
                                                selected.side,
                                                selected.symbol,
                                                selected.submarket || 'random_index',
                                                baselineCounts,
                                                token
                                            )
                                        )
                                            throw new Error('The XML bot could not be selected.');
                                    } catch (error) {
                                        xmlScannerCycle.stop(
                                            error instanceof Error
                                                ? error.message
                                                : 'Unable to load the selected XML bot.'
                                        );
                                    }
                                    return;
                                }
                            }
                            setResults(previous => [
                                ...previous.filter(
                                    item => item.symbol !== market.symbol && Date.now() - item.checkedAt < 60000
                                ),
                                ...matches,
                            ]);
                        },
                        setMessage,
                        {
                            stale: symbol => {
                                setResults(previous => previous.filter(item => item.symbol !== symbol));
                                setPreview(previous => (previous?.symbol === symbol ? undefined : previous));
                            },
                        }
                    );
                } catch (error) {
                    if (signal.aborted) return;
                    setResults([]);
                    setPreview(undefined);
                    setMessage(
                        `${error instanceof Error ? error.message : 'Market connection unavailable.'} Retrying in 5 seconds…`
                    );
                } finally {
                    api?.disconnect();
                    api = undefined;
                }
                if (!signal.aborted) await delay(5000, signal);
            }
        };
        void run();
        return () => {
            controller.abort();
            api?.disconnect();
        };
    }, [scanning, enabled, sampleSize]);
    return (
        <section className='digit-scanner' aria-labelledby='digit-scanner-title'>
            <h2 id='digit-scanner-title'>Over / Under market scanner</h2>
            <p>
                Scans Volatility markets using the latest {sampleSize.toLocaleString()} ticks. All supported markets are
                observed live at the same time.
            </p>
            <div className='digit-scanner__controls'>
                {(
                    [
                        ['stake', 'Stake ($)', '0.35', '0.01'],
                        ['stopLoss', 'Session stop loss ($)', '0.35', '0.01'],
                        ['takeProfit', 'Session take profit ($)', '0.01', '0.01'],
                        ['multiplier', 'Martingale (×)', '1.01', '0.01'],
                    ] as const
                ).map(([key, label, min, step]) => (
                    <label key={key}>
                        {label}
                        <input
                            type='number'
                            min={min}
                            step={step}
                            inputMode='decimal'
                            max={key === 'stake' ? 100 : undefined}
                            value={auto.enabled ? auto.settings[key] : draft[key]}
                            disabled={auto.enabled || preparing}
                            onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))}
                        />
                    </label>
                ))}

                <button disabled={auto.enabled} onClick={() => setEnabled(value => !value)}>
                    {enabled ? 'PAUSE' : 'RESUME'}
                </button>
                <button
                    disabled={auto.enabled || preparing}
                    onClick={async () => {
                        const attempt = ++startAttempt.current;
                        setPreparing(true);
                        try {
                            const settings = validateXmlAutoSettings({
                                stake: Number(draft.stake),
                                stopLoss: Number(draft.stopLoss),
                                takeProfit: Number(draft.takeProfit),
                                multiplier: Number(draft.multiplier),
                            });
                            const account = getDerivAccount();
                            if (!account) throw new Error('Log in with Deriv and select an account first.');
                            if (isAnalysisTrading() || (await checkServerAnalysis()))
                                throw new Error('Stop and settle the Analysis Tool before starting XML Auto.');
                            if (
                                attempt !== startAttempt.current ||
                                getDerivAccount()?.account_id !== account.account_id
                            )
                                return;
                            if (!onAutoStart) throw new Error('XML Auto is unavailable here.');
                            onAutoStart(settings);
                            setEnabled(true);
                            setLoadError('');
                        } catch (error) {
                            if (attempt === startAttempt.current)
                                setLoadError(error instanceof Error ? error.message : 'Unable to start XML Auto.');
                        } finally {
                            if (attempt === startAttempt.current) setPreparing(false);
                        }
                    }}
                >
                    START XML AUTO
                </button>
                <button
                    disabled={!auto.enabled && !preparing}
                    onClick={() => {
                        startAttempt.current++;
                        setPreparing(false);
                        xmlScannerCycle.stop();
                    }}
                >
                    STOP XML AUTO
                </button>
            </div>
            <p className='digit-analysis__note'>
                XML Auto runs three-win batches with Even/Odd recovery. Keep this tab open and connected.
            </p>
            {auto.phase !== 'idle' && (
                <p role='status'>
                    {auto.message} · Batch wins {auto.wins}/3 · Batches {auto.batches} · Session P/L{' '}
                    {(auto.pnl / 100).toFixed(2)}
                    {auto.deficit > 0 && ` · Recovery deficit $${(auto.deficit / 100).toFixed(2)}`}
                </p>
            )}
            <p role='status' aria-live='polite'>
                {auto.enabled && !scanning ? 'XML Auto active · Follow the session status above.' : message}
            </p>
            {preview && (
                <div className='digit-scanner__preview'>
                    <h3>
                        {auto.enabled && !scanning ? 'Last scan' : 'Checking'}: {preview.display_name}
                    </h3>
                    <p>
                        Last checked {new Date(preview.checkedAt).toLocaleTimeString()} · {preview.digits.length} ticks
                        ·{' '}
                        {preview.matchedSides.length
                            ? `${preview.matchedSides.map(side => (side === 'over' ? 'Over' : 'Under')).join(' / ')} conditions matched`
                            : 'Neither Over nor Under conditions matched'}
                    </p>
                    <div className='digit-scanner__circles' aria-label='Scanner digit percentages'>
                        {digitFrequencies(preview.digits).map((item, digit) => (
                            <div
                                key={digit}
                                className={`digit-scanner__circle${preview.redDigits.includes(digit) ? ' digit-scanner__circle--red' : ''}${preview.greenDigits.includes(digit) ? ' digit-scanner__circle--green' : ''}`}
                                aria-label={`Digit ${digit}: ${item.percent.toFixed(1)} percent${preview.redDigits.includes(digit) ? ', least frequent' : ''}${preview.greenDigits.includes(digit) ? ', most frequent' : ''}`}
                            >
                                <strong>{digit}</strong>
                                <span>{item.percent.toFixed(1)}%</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {loadError && <p role='alert'>{loadError}</p>}
            {results.length > 0 && (
                <h3 className='digit-scanner__found' role='status'>
                    Market found · {results.length} {results.length === 1 ? 'match' : 'matches'}
                </h3>
            )}
            <div className='digit-scanner__results'>
                {results.map(result => (
                    <article key={`${result.symbol}-${result.side}`}>
                        <h3>
                            {result.display_name} · {result.side === 'over' ? 'Over' : 'Under'}
                        </h3>
                        <p>{result.selected.map(item => `${item.digit}: ${item.percent.toFixed(2)}%`).join(' · ')}</p>
                        <p>
                            Red: {result.redDigits.join(', ')} · Green: {result.greenDigits.join(', ')}
                        </p>
                        <p>Last matched {new Date(result.checkedAt).toLocaleTimeString()}. Conditions may change.</p>
                        <p>
                            Suggested bot:{' '}
                            <strong>{result.side === 'over' ? 'Over Punisher' : 'Under Punisher'}</strong>
                        </p>
                        <div className='digit-scanner__actions'>
                            <button disabled={auto.enabled} onClick={() => onSelect(result.symbol)}>
                                View digits
                            </button>
                            <button
                                disabled={auto.enabled}
                                onClick={() => {
                                    try {
                                        if (
                                            onLoad(
                                                result.side,
                                                result.symbol,
                                                result.submarket || 'random_index',
                                                digitFrequencies(result.digits).map(item => item.count)
                                            )
                                        ) {
                                            setLoadError('');
                                        }
                                    } catch (error) {
                                        setLoadError(
                                            error instanceof Error ? error.message : 'Unable to load this bot.'
                                        );
                                    }
                                }}
                            >
                                Load Bot
                            </button>
                        </div>
                    </article>
                ))}
            </div>
            <p>
                Manual scanning pauses when you leave this section. XML Auto continues until stopped or a limit is
                reached. Manual Load Bot lets you review the XML before running it.
            </p>
        </section>
    );
}
