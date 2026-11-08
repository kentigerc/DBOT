import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { manualTraderGate } from '@/utils/manual-trader-gate';
import {
    manualEntryReady,
    SWITCHERS,
    watchManualMarkets,
    type ManualMarket,
    type ManualSide,
} from '@/utils/manual-trader-markets';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import DigitCircles from '../digit-analysis/digit-circles';
import '../digit-analysis/digit-analysis.scss';
import './manual-trader.scss';

const ManualTrader = observer(({ active = true }: { active?: boolean }) => {
    const panel = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const { dashboard, run_panel } = useStore();
    const navigate = useNavigate();
    const gate = useSyncExternalStore(manualTraderGate.subscribe, manualTraderGate.getSnapshot);
    const latest = useRef(new Map<string, ManualMarket>());
    const [markets, setMarkets] = useState<ManualMarket[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [status, setStatus] = useState('Connecting to live markets…');
    const [error, setError] = useState('');
    const [beat, setBeat] = useState(0);
    const [observedSymbol, setObservedSymbol] = useState('');
    const [starting, setStarting] = useState(false);
    const launching = useRef(false);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setBeat(value => value + 1), 1000);
        return () => clearInterval(timer);
    }, [active]);
    useEffect(() => {
        if (!active || !enabled) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        latest.current.clear();
        setMarkets([]);
        const flush = () => {
            if (controller.signal.aborted || timer) return;
            timer = setTimeout(() => {
                timer = undefined;
                if (!controller.signal.aborted) setMarkets([...latest.current.values()]);
            }, 100);
        };
        void watchManualMarkets(
            () => generateDerivApiInstance({ publicOnly: true }),
            controller.signal,
            market => {
                latest.current.set(market.symbol, market);
                flush();
            },
            setStatus,
            symbol => {
                if (symbol) latest.current.delete(symbol);
                else latest.current.clear();
                flush();
            }
        );
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [active, enabled]);
    const scanning = active && enabled;
    const candidates = scanning
        ? markets
              .flatMap(market =>
                  (['over', 'under'] as const)
                      .filter(side => manualEntryReady(market, side))
                      .map(side => ({ market, side }))
              )
              .sort((a, b) => b.market[b.side].percentage - a.market[a.side].percentage)
        : [];
    const match = candidates[0];
    const pinnedSymbol = observedSymbol || gate.plan?.symbol;
    const focus = pinnedSymbol
        ? markets.find(market => market.symbol === pinnedSymbol)
        : match?.market || markets[Math.floor(beat / 2) % markets.length];
    const run = async () => {
        if (launching.current || gate.active || run_panel.is_running || run_panel.has_open_contract) return;
        launching.current = true;
        setStarting(true);
        setError('');
        try {
            const workspace = (
                window.Blockly as unknown as { derivWorkspace?: Parameters<typeof manualTraderGate.isLoaded>[0] }
            )?.derivWorkspace;
            if (!manualTraderGate.isLoaded(workspace))
                throw new Error('Load your selected bot in Bot Builder first, then return here to press RUN.');
            setObservedSymbol('');
            const result = await run_panel.onRunButtonClick();
            if (!result?.started)
                throw new Error(result?.reason || 'The bot could not start. Check Bot Builder’s Journal.');
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Unable to start the selected bot.');
        } finally {
            launching.current = false;
            setStarting(false);
        }
    };
    const load = (market: ManualMarket, side: ManualSide) => {
        setError('');
        try {
            const fresh = latest.current.get(market.symbol);
            if (!scanning || !fresh || !manualEntryReady(fresh, side))
                throw new Error('This entry has changed. Waiting for another qualifying live market.');
            const account = getDerivAccount();
            if (!getDerivSession().authenticated || !account || account.status !== 'active')
                throw new Error('Log in with Deriv and select an active account first.');
            if (account.currency !== 'USD') throw new Error('Select a USD account for these Switcher bots.');
            if (run_panel.is_running || run_panel.has_open_contract || xmlScannerCycle.getSnapshot().enabled)
                throw new Error('Stop and settle the current XML bot before loading another.');
            const bot = SWITCHERS[side];
            sessionStorage.setItem(
                'neto.pendingBot',
                JSON.stringify({
                    fileName: bot.fileName,
                    name: bot.name,
                    symbol: fresh.symbol,
                    submarket: fresh.submarket,
                    manualTraderSide: side,
                })
            );
            window.dispatchEvent(new Event('neto-pending-bot'));
            dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
            navigate('/platform#bot_builder');
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Unable to load the selected bot.');
        }
    };
    return (
        <section className='manual-trader' ref={panel} tabIndex={0} aria-labelledby='manual-trader-title'>
            <header className='manual-trader__heading'>
                <div>
                    <p className='manual-trader__eyebrow'>YOUR ENTRY. YOUR CONTROL.</p>
                    <h1 id='manual-trader-title'>Manual Trader</h1>
                    <p>
                        Live market analysis for Over Switcher and Under Switcher. Load a bot in Bot Builder, return
                        here to watch the circles, then press RUN when you are ready.
                    </p>
                </div>
                <button onClick={() => setEnabled(value => !value)}>
                    {enabled ? 'Pause scanner' : 'Resume scanner'}
                </button>
            </header>
            <div className='manual-trader__summary'>
                <span>{scanning ? 'Live scanning' : 'Scanner paused'}</span>
                <span>{markets.filter(market => market.ready).length} markets live</span>
                <span>1,000 ticks per market</span>
            </div>
            <p className='manual-trader__status' role='status'>
                {scanning ? status : 'Displayed percentages are snapshots.'}
            </p>
            {gate.plan && (
                <aside className='manual-trader__selected'>
                    <strong>
                        {gate.plan.name} · {gate.plan.symbol}
                    </strong>
                    <span>{gate.phase}</span>
                    {gate.active ? (
                        <button onClick={() => run_panel.onStopButtonClick()}>Stop bot</button>
                    ) : (
                        <button
                            className='manual-trader__run'
                            disabled={starting || run_panel.is_running || run_panel.has_open_contract}
                            onClick={run}
                        >
                            {starting ? 'Starting…' : 'RUN'}
                        </button>
                    )}
                </aside>
            )}
            {error && <p role='alert'>{error}</p>}
            <label className='manual-trader__observe'>
                Market to observe
                <select value={observedSymbol} onChange={event => setObservedSymbol(event.target.value)}>
                    <option value=''>{gate.plan ? 'Follow loaded bot market' : 'Automatic market preview'}</option>
                    {markets.map(market => (
                        <option key={market.symbol} value={market.symbol}>
                            {market.name}
                        </option>
                    ))}
                </select>
            </label>
            {focus ? (
                <article className='manual-trader__market'>
                    <div className='manual-trader__market-heading'>
                        <div>
                            <span className='manual-trader__eyebrow'>MARKET PREVIEW</span>
                            <h2>{focus.name}</h2>
                        </div>
                        <span>
                            Last digit <strong>{focus.latest ?? '—'}</strong>
                        </span>
                    </div>
                    <div className='manual-trader__shares'>
                        {(['over', 'under'] as const).map(side => {
                            const reading = focus[side];
                            const ready = scanning && manualEntryReady(focus, side);
                            return (
                                <div key={side} className={`manual-trader__share manual-trader__share--${side}`}>
                                    <div>
                                        <h3>{SWITCHERS[side].name}</h3>
                                        <strong>{reading.percentage.toFixed(1)}%</strong>
                                    </div>
                                    <div
                                        className='manual-trader__bar'
                                        role='meter'
                                        aria-label={`${side === 'over' ? 'Over' : 'Under'} winning digit share`}
                                        aria-valuenow={reading.percentage}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                    >
                                        <span style={{ width: `${reading.percentage}%` }} />
                                    </div>
                                    <p>
                                        {ready
                                            ? 'Entry qualified'
                                            : !scanning
                                              ? 'Snapshot'
                                              : reading.change > 0
                                                ? 'Rising · Observing entry'
                                                : 'Observing market conditions'}
                                    </p>
                                </div>
                            );
                        })}
                    </div>
                    <div className='manual-trader__circles'>
                        <DigitCircles digits={focus.ticks} />
                    </div>
                </article>
            ) : (
                <div className='manual-trader__empty'>
                    {scanning ? 'Waiting for live market readings…' : 'Resume the scanner to analyse markets.'}
                </div>
            )}
            <section className={`manual-trader__match${match ? ' is-ready' : ''}`} aria-label='Suggested bot'>
                {match ? (
                    <>
                        <div>
                            <p className='manual-trader__eyebrow'>MARKET FOUND</p>
                            <h2>{SWITCHERS[match.side].name}</h2>
                            <p>
                                {match.market.name} · {match.side === 'over' ? 'Over' : 'Under'} ·{' '}
                                {match.market[match.side].percentage.toFixed(1)}%
                            </p>
                        </div>
                        <button
                            disabled={run_panel.is_running || gate.active}
                            onClick={() => load(match.market, match.side)}
                        >
                            Load Bot
                        </button>
                    </>
                ) : (
                    <div>
                        <h2>Looking for a qualifying entry</h2>
                        <p>
                            All supported Volatility markets are observed together. The preview rotates while searching.
                        </p>
                    </div>
                )}
            </section>
            <p className='manual-trader__note'>
                Loading never starts trading. Press RUN when you are ready; the XML bot then trades continuously until
                you press STOP or its risk limits are reached. Recovery follows the XML bot’s own rules. Keep this tab
                open and connected.
            </p>
        </section>
    );
});
export default ManualTrader;
