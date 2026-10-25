import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivSession } from '@/utils/deriv-session';
import DigitCycle from './digit-cycle';
import { digitFrequencies } from './digits';
import { DigitMarket, subscribeLiveDigits } from './live-digits';
import MarketScanner from './market-scanner';
import './digit-analysis.scss';

export default function DigitAnalysis({ active = true }: { active?: boolean }) {
    const navigate = useNavigate();
    const { dashboard, run_panel } = useStore();
    const panelRef = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const [markets, setMarkets] = useState<DigitMarket[]>([]);
    const [symbol, setSymbol] = useState('R_100');
    const [sampleSize, setSampleSize] = useState(1000);
    const [digits, setDigits] = useState<number[]>([]);
    const [latest, setLatest] = useState('');
    const [status, setStatus] = useState('Connecting to market…');
    const [error, setError] = useState('');

    useEffect(() => {
        setDigits([]);
        setLatest('');
        return subscribeLiveDigits({
            symbol,
            sampleSize,
            onSnapshot: (nextDigits, quote) => {
                setDigits(nextDigits);
                setLatest(quote);
            },
            onMarkets: setMarkets,
            onStatus: (nextStatus, nextError) => {
                setStatus(nextStatus);
                setError(nextError);
            },
        });
    }, [symbol, sampleSize]);

    const frequencies = digitFrequencies(digits);
    const highest = Math.max(...frequencies.map(item => item.count));
    const lowest = Math.min(...frequencies.map(item => item.count));
    const latestDigit = digits.at(-1);
    const marketName = markets.find(market => market.symbol === symbol)?.display_name || symbol;
    return (
        <section className='digit-analysis' aria-labelledby='digit-analysis-title' ref={panelRef} tabIndex={0}>
            <div className='digit-analysis__heading'>
                <div>
                    <p className='digit-analysis__eyebrow'>LIVE MARKET STATISTICS</p>
                    <h1 id='digit-analysis-title'>Digit Analysis</h1>
                    <p>See how often each last digit appears in the latest market ticks.</p>
                </div>
                <span
                    className={`digit-analysis__status${error ? ' digit-analysis__status--offline' : ''}`}
                    role='status'
                >
                    {status}
                </span>
            </div>
            <div className='digit-analysis__controls'>
                <label>
                    Market
                    <select value={symbol} onChange={event => setSymbol(event.target.value)}>
                        {!markets.some(market => market.symbol === symbol) && (
                            <option value={symbol}>{marketName}</option>
                        )}
                        {markets.map(market => (
                            <option key={market.symbol} value={market.symbol}>
                                {market.display_name}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Sample size
                    <select value={sampleSize} onChange={event => setSampleSize(Number(event.target.value))}>
                        {[100, 500, 1000].map(size => (
                            <option key={size} value={size}>
                                Last {size.toLocaleString()} ticks
                            </option>
                        ))}
                    </select>
                </label>
                <div className='digit-analysis__quote'>
                    <span>Latest quote</span>
                    <strong>{latest || '—'}</strong>
                </div>
                <div className='digit-analysis__quote'>
                    <span>Ticks in sample</span>
                    <strong>
                        {digits.length.toLocaleString()} / {sampleSize.toLocaleString()}
                    </strong>
                </div>
            </div>
            {error && (
                <div className='digit-analysis__error' role='alert'>
                    {error}
                </div>
            )}
            <div className='digit-analysis__grid' aria-label='Last-digit frequencies'>
                {frequencies.map((item, digit) => {
                    const high = digits.length > 0 && highest !== lowest && item.count === highest;
                    const low = digits.length > 0 && highest !== lowest && item.count === lowest;
                    return (
                        <div
                            key={digit}
                            className={`digit-analysis__digit${high ? ' digit-analysis__digit--high' : ''}${low ? ' digit-analysis__digit--low' : ''}${latestDigit === digit ? ' digit-analysis__digit--latest' : ''}`}
                        >
                            <div
                                className='digit-analysis__circle'
                                aria-label={`Digit ${digit}: ${item.percent.toFixed(1)} percent, ${item.count} ticks`}
                            >
                                <strong>{digit}</strong>
                                <span>{item.percent.toFixed(1)}%</span>
                            </div>
                            <span className='digit-analysis__count'>{item.count} ticks</span>
                            <span className='digit-analysis__marker'>
                                {latestDigit === digit
                                    ? 'Latest digit'
                                    : high
                                      ? 'Most frequent'
                                      : low
                                        ? 'Least frequent'
                                        : '\u00a0'}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className='digit-analysis__legend'>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--high' />
                    Most frequent
                </span>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--low' />
                    Least frequent
                </span>
                <span>
                    <i className='digit-analysis__key' />
                    Latest digit
                </span>
            </div>
            <MarketScanner
                sampleSize={sampleSize}
                onSelect={setSymbol}
                active={active}
                onLoad={(side, matchedSymbol, submarket, baselineCounts) => {
                    if (!getDerivSession().authenticated)
                        throw new Error('Log in with Deriv to load a NetoAcademy bot.');
                    if (run_panel.is_running) throw new Error('Stop your running bot before loading another bot.');
                    sessionStorage.setItem(
                        'neto.pendingBot',
                        JSON.stringify({
                            fileName: side === 'over' ? 'over-punisher.xml' : 'under-punisher.xml',
                            name: side === 'over' ? 'Over Punisher' : 'Under Punisher',
                            symbol: matchedSymbol,
                            submarket,
                            scannerSide: side,
                            baselineCounts,
                            sampleSize,
                        })
                    );
                    dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
                    navigate('/#bot_builder');
                    return true;
                }}
            />
            <DigitCycle />
            <p className='digit-analysis__note'>
                Percentages describe the selected rolling sample of past ticks. They do not predict the next digit or
                guarantee a trading outcome.
            </p>
        </section>
    );
}
