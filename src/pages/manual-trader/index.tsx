import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { manualTraderGate } from '@/utils/manual-trader-gate';
import { builderDemoPause } from '@/utils/builder-demo-pause';
import DemoPauseStatus from '@/components/demo-pause-status';
import {
    manualEntryReady,
    manualLead,
    rankManualMarkets,
    DEFAULT_MANUAL_LEAD,
    MANUAL_MOMENTUM_TICKS,
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
    const builderDemo = useSyncExternalStore(builderDemoPause.subscribe, builderDemoPause.getSnapshot);
    const demoPause = gate.active && builderDemo.accountId === gate.plan?.accountId ? builderDemo.demoPause : undefined;
    const latest = useRef(new Map<string, ManualMarket>());
    const [markets, setMarkets] = useState<ManualMarket[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [status, setStatus] = useState('Connecting to live markets…');
    const [error, setError] = useState('');
    const [beat, setBeat] = useState(0);
    const [observedSymbol, setObservedSymbol] = useState('');
    const [minimumLead, setMinimumLead] = useState(String(DEFAULT_MANUAL_LEAD));
    const lead = Number(minimumLead);
    const validLead = minimumLead.trim() !== '' && Number.isFinite(lead) && lead >= 0.1 && lead <= 100;
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
    const candidates = scanning && validLead ? rankManualMarkets(markets, Date.now(), lead) : [];
    const match = candidates[0];
    const pinnedSymbol = observedSymbol || gate.plan?.symbol;
    const focus = pinnedSymbol
        ? markets.find(market => market.symbol === pinnedSymbol)
        : match?.market || markets[Math.floor(beat / 2) % markets.length];
    const load = (market: ManualMarket, side: ManualSide) => {
        setError('');
        try {
            const best = rankManualMarkets([...latest.current.values()], Date.now(), lead)[0];
            if (!scanning || !validLead || !best)
                throw new Error('This entry has changed. Waiting for another qualifying live market.');
            if (best.market.symbol !== market.symbol || best.side !== side)
                throw new Error('A stronger live match is now available. Review the latest suggestion.');
            const fresh = best.market;
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
                        here to watch the circles, then use the Run/Stop bar when you are ready. Open its progress panel
                        to view Summary, Transactions and Journal.
                    </p>
                </div>
                <div className='manual-trader__controls'>
                    <label>
                        Minimum lead (pp)
                        <input
                            type='number'
                            inputMode='decimal'
                            min='0.1'
                            max='100'
                            step='0.1'
                            value={minimumLead}
                            onChange={event => {
                                setMinimumLead(event.target.value);
                                setError('');
                            }}
                        />
                    </label>
                    <button onClick={() => setEnabled(value => !value)}>
                        {enabled ? 'Pause scanner' : 'Resume scanner'}
                    </button>
                </div>
            </header>
            <div className='manual-trader__summary'>
                <span>{scanning ? 'Live scanning' : 'Scanner paused'}</span>
                <span>{markets.filter(market => market.ready).length} markets live</span>
                <span>1,000 ticks per market</span>
                <span>
                    {markets.filter(market => market.trend.samples >= MANUAL_MOMENTUM_TICKS).length} momentum windows
                    ready
                </span>
            </div>
            <p className='manual-trader__status' role='status'>
                {scanning ? status : 'Displayed percentages are snapshots.'}
            </p>
            {gate.plan && (
                <aside className='manual-trader__selected'>
                    <strong>
                        {gate.plan.name} · {gate.plan.symbol}
                    </strong>
                    <span>
                        {demoPause?.status === 'running' ? 'Demo pause · Waiting for one demo win' : gate.phase}
                    </span>
                </aside>
            )}
            <DemoPauseStatus state={demoPause} />
            {(error || !validLead) && (
                <p role='alert'>{error || 'Enter a minimum lead from 0.1 to 100 percentage points.'}</p>
            )}
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
                            const ready = scanning && validLead && manualEntryReady(focus, side, Date.now(), lead);
                            const momentum = focus.trend[side];
                            const difference = manualLead(focus, side);
                            const fresh =
                                focus.ready &&
                                Date.now() - focus.checkedAt <= 3500 &&
                                Date.now() / 1000 - focus.epoch <= 6;
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
                                        {MANUAL_MOMENTUM_TICKS}-tick momentum:{' '}
                                        {momentum === null
                                            ? '—'
                                            : `${momentum > 0 ? '+' : ''}${momentum.toFixed(1)} pp`}
                                        {' · '}Lead: {difference > 0 ? '+' : ''}
                                        {difference.toFixed(1)} pp
                                    </p>
                                    <p>
                                        {ready
                                            ? 'Entry qualified'
                                            : !scanning
                                              ? 'Snapshot'
                                              : !fresh
                                                ? 'Waiting for fresh live data'
                                                : focus.trend.samples < MANUAL_MOMENTUM_TICKS
                                                  ? `Building momentum · ${focus.trend.samples}/${MANUAL_MOMENTUM_TICKS} live ticks`
                                                  : difference < lead
                                                    ? 'No clear lead'
                                                    : (momentum ?? 0) <= 0
                                                      ? 'Waiting for rising momentum'
                                                      : 'Observing entry formation'}
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
                            <p className='manual-trader__rank'>
                                Combined rank #1 of {candidates.length} qualifying entries
                            </p>
                            <small>
                                Share rank #{match.shareRank} · Momentum rank #{match.momentumRank}
                            </small>
                            <dl className='manual-trader__metrics'>
                                <div>
                                    <dt>Chosen share</dt>
                                    <dd>{match.percentage.toFixed(1)}%</dd>
                                </div>
                                <div>
                                    <dt>Opposite share</dt>
                                    <dd>
                                        {match.market[match.side === 'over' ? 'under' : 'over'].percentage.toFixed(1)}%
                                    </dd>
                                </div>
                                <div>
                                    <dt>Lead</dt>
                                    <dd>+{match.lead.toFixed(1)} pp</dd>
                                </div>
                                <div>
                                    <dt>{MANUAL_MOMENTUM_TICKS}-tick momentum</dt>
                                    <dd>+{match.momentum.toFixed(1)} pp</dd>
                                </div>
                            </dl>
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
                        <h2>No clear entry</h2>
                        <p>
                            Waiting for rising {MANUAL_MOMENTUM_TICKS}-tick momentum, a{' '}
                            {validLead ? lead.toFixed(1) : 'valid'} pp lead and the entry formation. All supported
                            Volatility markets are observed together.
                        </p>
                    </div>
                )}
            </section>
            <p className='manual-trader__note'>
                Loading never starts trading. Press RUN when you are ready; the XML bot then trades continuously until
                you press STOP or its risk limits are reached. Recovery follows the XML bot’s own rules. Keep this tab
                open and connected. Rankings combine share and momentum from recent ticks and do not guarantee trade
                results.
            </p>
        </section>
    );
});
export default ManualTrader;
