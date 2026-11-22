import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivAccount } from '@/utils/deriv-session';
import {
    checkMomentumEntry,
    RISE_FALL_BOT_FILE,
    RISE_FALL_BOT_NAME,
    type MomentumDuration,
} from '@/utils/rise-fall-momentum';
import type { VolatilityMarket } from '@/utils/live-volatility-markets';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import '../manual-trader/manual-trader.scss';

const MomentumAnalyzer = observer(({ active }: { active: boolean }) => {
    const panel = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const { dashboard, run_panel } = useStore();
    const navigate = useNavigate();
    const [markets, setMarkets] = useState<VolatilityMarket[]>([]);
    const [symbol, setSymbol] = useState('');
    const [duration, setDuration] = useState<MomentumDuration>(1);
    const [entry, setEntry] = useState<Awaited<ReturnType<typeof checkMomentumEntry>>>();
    const [status, setStatus] = useState('Connecting to Deriv…');
    const [error, setError] = useState('');
    const market = markets.find(item => item.symbol === symbol);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        void (async () => {
            try {
                api = await generateDerivApiInstance({ publicOnly: true });
                if (cancelled) return api.disconnect();
                const response = await api.send({ active_symbols: 'brief' });
                if (cancelled) return;
                const available: VolatilityMarket[] = (response.active_symbols ?? []).filter(
                    (item: VolatilityMarket) => /^(R_\d+|1HZ\d+V)$/.test(item.symbol) &&
                        item.exchange_is_open && !item.is_trading_suspended
                );
                setMarkets(available);
                setSymbol(value => available.some(item => item.symbol === value) ? value : available[0]?.symbol ?? '');
                setStatus(available.length ? 'Select a market and duration.' : 'No open Volatility markets were returned.');
            } catch {
                if (!cancelled) setStatus('Could not load Volatility markets.');
            }
        })();
        return () => {
            cancelled = true;
            api?.disconnect();
        };
    }, [active]);

    useEffect(() => {
        setEntry(undefined);
        if (!active || !symbol) return;
        let cancelled = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>> | undefined;
        let timer: ReturnType<typeof setTimeout>;
        const scan = async () => {
            try {
                api ??= await generateDerivApiInstance({ publicOnly: true });
                if (cancelled) return api.disconnect();
                const result = await checkMomentumEntry(body => api!.send(body), symbol, duration, 'USD', 3);
                if (cancelled) return;
                setEntry(result);
                setStatus(result?.qualified ? 'Qualifying momentum signal' : 'No trade');
            } catch (reason) {
                if (cancelled) return;
                setEntry(undefined);
                setStatus(reason instanceof Error ? reason.message : 'Market data unavailable.');
            }
            timer = setTimeout(scan, 2000);
        };
        setStatus('Checking price momentum…');
        void scan();
        return () => {
            cancelled = true;
            clearTimeout(timer);
            api?.disconnect();
        };
    }, [active, symbol, duration]);

    const load = () => {
        setError('');
        if (!entry?.qualified || !entry.fresh() || !market) return setError('Wait for a fresh qualifying signal.');
        const account = getDerivAccount();
        if (account?.account_type !== 'demo' || account.status !== 'active' || account.currency !== 'USD')
            return setError('Select an active USD Deriv demo account to load this momentum setup.');
        if (run_panel.is_running || run_panel.has_open_contract || xmlScannerCycle.getSnapshot().enabled)
            return setError('Stop and settle the current bot first.');
        sessionStorage.setItem('neto.pendingBot', JSON.stringify({
            fileName: RISE_FALL_BOT_FILE, name: RISE_FALL_BOT_NAME,
            symbol, submarket: market.submarket, momentum: { direction: entry.direction, duration },
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
                    <p>Compare recent price direction with the win rate required by a live Deriv quote.</p>
                </div>
                <div className='manual-trader__controls'>
                    <label>Volatility market
                        <select value={symbol} onChange={event => { setEntry(undefined); setError(''); setSymbol(event.target.value); }}>
                            {markets.map(item => <option key={item.symbol} value={item.symbol}>{item.display_name || item.symbol}</option>)}
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
            <p className='manual-trader__status' role='status'>{status}</p>
            <section className='manual-trader__match' aria-label='Momentum estimate'>
                {entry && (
                    <dl className='manual-trader__metrics'>
                        <div><dt>Direction</dt><dd>{entry.direction === 'CALL' ? 'Rise' : 'Fall'}</dd></div>
                        <div><dt>Historical win rate</dt><dd>{(entry.winRate * 100).toFixed(1)}% ({entry.samples} samples)</dd></div>
                        <div><dt>Conservative estimate</dt><dd>{(entry.lowerBound * 100).toFixed(1)}%</dd></div>
                        <div><dt>Quote break-even</dt><dd>{(entry.breakEven * 100).toFixed(1)}%</dd></div>
                    </dl>
                )}
                <button type='button' onClick={load} disabled={!entry?.qualified}>Load Rise/Fall Bot</button>
                {error && <p role='alert'>{error}</p>}
            </section>
            <p className='manual-trader__note'>Demo only. Historical results can occur by chance. The bot rechecks each entry after you press Run.</p>
        </section>
    );
});

export default MomentumAnalyzer;
