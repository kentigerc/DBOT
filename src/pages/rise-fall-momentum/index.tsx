import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount } from '@/utils/deriv-session';
import {
    MOMENTUM_HISTORY,
    quoteMomentumEntry,
    RISE_FALL_BOT_FILE,
    RISE_FALL_BOT_NAME,
    type MomentumDuration,
    type MomentumMode,
} from '@/utils/rise-fall-momentum';
import { observeVolatilityMarkets, type VolatilityMarket } from '@/utils/live-volatility-markets';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import '../manual-trader/manual-trader.scss';

const MomentumAnalyzer = observer(({ active }: { active: boolean }) => {
    const panel = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const { dashboard, run_panel } = useStore();
    const navigate = useNavigate();
    const [duration, setDuration] = useState<MomentumDuration>(1);
    const [mode, setMode] = useState<MomentumMode>('demo');
    type Quote = NonNullable<Awaited<ReturnType<typeof quoteMomentumEntry>>>;
    type Entry = { market: VolatilityMarket; quote: Quote };
    const [entry, setEntry] = useState<Entry>();
    const [status, setStatus] = useState('Connecting to Deriv…');
    const [error, setError] = useState('');

    useEffect(() => {
        setEntry(undefined);
        if (!active) return;
        const controller = new AbortController();
        const { signal } = controller;
        const feeds = new Map<string, { market: VolatilityMarket; prices: readonly number[]; epoch: number }>();
        const entries = new Map<string, Entry>();
        const inFlight = new Set<string>();
        const nextCheck = new Map<string, number>();
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        let retry: ReturnType<typeof setTimeout>;

        const publish = () => {
            if (signal.aborted) return;
            const best = [...entries.values()]
                .filter(({ quote }) => quote.fresh())
                .sort((a, b) => b.quote.margin - a.quote.margin ||
                    a.market.symbol.localeCompare(b.market.symbol))[0];
            setEntry(best);
        };
        const scan = () => {
            if (!api || signal.aborted) return;
            const now = Date.now();
            for (const [symbol, feed] of feeds) {
                if (inFlight.size >= 4) break;
                if (inFlight.has(symbol) || now < (nextCheck.get(symbol) ?? 0)) continue;
                inFlight.add(symbol);
                nextCheck.set(symbol, now + 3000);
                void quoteMomentumEntry(body => api!.send(body), symbol, duration, 'USD', 3, feed.prices, feed.epoch, undefined, mode)
                    .then(quote => {
                        if (signal.aborted || !feeds.has(symbol)) return;
                        if (quote?.fresh()) entries.set(symbol, { market: feed.market, quote });
                        else entries.delete(symbol);
                    })
                    .catch(() => {
                        entries.delete(symbol);
                        nextCheck.set(symbol, Date.now() + 5000);
                    })
                    .finally(() => {
                        inFlight.delete(symbol);
                        publish();
                    });
            }
            publish();
        };
        const connect = async () => {
            setStatus('Connecting to Deriv…');
            try {
                const connection = await generateDerivApiInstance({ publicOnly: true });
                if (signal.aborted) return connection.disconnect();
                api = connection;
                await observeVolatilityMarkets(connection, MOMENTUM_HISTORY, signal, () => {}, setStatus, {
                    prices: (market, prices, epoch) => {
                        feeds.set(market.symbol, { market, prices, epoch });
                    },
                    stale: symbol => {
                        feeds.delete(symbol);
                        entries.delete(symbol);
                        publish();
                    },
                });
            } catch {
                if (signal.aborted) return;
                feeds.clear();
                entries.clear();
                publish();
                setStatus('Market connection interrupted. Reconnecting…');
                retry = setTimeout(connect, 3000);
            } finally {
                api?.disconnect();
                api = undefined;
            }
        };

        const timer = setInterval(scan, 250);
        void connect();
        return () => {
            controller.abort();
            clearInterval(timer);
            clearTimeout(retry);
        };
    }, [active, duration, mode]);

    const load = () => {
        setError('');
        if (!entry?.quote.qualified || !entry.quote.fresh()) return setError('Wait for a fresh qualifying signal.');
        const { market, quote } = entry;
        const account = getDerivAccount();
        if (account?.account_type !== 'demo' || account.status !== 'active' || account.currency !== 'USD')
            return setError('Select an active USD Deriv demo account to load this momentum setup.');
        if (run_panel.is_running || run_panel.has_open_contract || xmlScannerCycle.getSnapshot().enabled)
            return setError('Stop and settle the current bot first.');
        sessionStorage.setItem('neto.pendingBot', JSON.stringify({
            fileName: RISE_FALL_BOT_FILE, name: RISE_FALL_BOT_NAME,
            symbol: market.symbol, submarket: market.submarket, momentum: { direction: quote.direction, duration, mode },
        }));
        window.dispatchEvent(new Event('neto-pending-bot'));
        dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
        navigate('/platform#bot_builder');
    };

    return (
        <section className='manual-trader' ref={panel} aria-labelledby='rise-fall-momentum-title'>
            <header className='manual-trader__heading'>
                <div>
                    <h1 id='rise-fall-momentum-title'>Rise/Fall Momentum</h1>
                    <p>Scan open Volatility markets for momentum that clears a live Deriv quote.</p>
                </div>
                <div className='manual-trader__controls'>
                    <label>Entry filter
                        <select value={mode} onChange={event => {
                            setEntry(undefined);
                            setError('');
                            setMode(event.target.value === 'strict' ? 'strict' : 'demo');
                        }}>
                            <option value='demo'>Demo exploration</option>
                            <option value='strict'>Strict</option>
                        </select>
                    </label>
                    <label>Duration
                        <select value={duration} onChange={event => { setEntry(undefined); setError(''); setDuration(event.target.value === '5' ? 5 : 1); }}>
                            <option value='1'>1 tick</option>
                            <option value='5'>5 ticks</option>
                        </select>
                    </label>
                </div>
            </header>
            <p className='manual-trader__status' role='status'>
                {entry?.quote.qualified ? 'Qualifying entry found' : entry ? 'No entry · closest market shown' : status}
            </p>
            <section className='manual-trader__match' aria-label='Momentum estimate'>
                {entry && (
                    <dl className='manual-trader__metrics'>
                        <div><dt>Market</dt><dd>{entry.market.display_name || entry.market.symbol}</dd></div>
                        <div><dt>Direction</dt><dd>{entry.quote.direction === 'CALL' ? 'Rise' : 'Fall'}</dd></div>
                        <div><dt>Historical win rate</dt><dd>{(entry.quote.winRate * 100).toFixed(1)}% ({entry.quote.samples} samples)</dd></div>
                        <div><dt>Conservative estimate</dt><dd>{(entry.quote.lowerBound * 100).toFixed(1)}%</dd></div>
                        <div><dt>Quote break-even</dt><dd>{(entry.quote.breakEven * 100).toFixed(1)}%</dd></div>
                    </dl>
                )}
                <button type='button' onClick={load} disabled={!entry?.quote.qualified}>Load Rise/Fall Bot</button>
                {error && <p role='alert'>{error}</p>}
            </section>
            <p className='manual-trader__note'>Demo only. Exploration compares the historical win rate with the quote. Strict also accounts for sampling uncertainty. The bot rechecks each entry after you press Run.</p>
        </section>
    );
});

export default MomentumAnalyzer;
