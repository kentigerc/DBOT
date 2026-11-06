import { useEffect, useState } from 'react';
import DigitCircles from '@/pages/digit-analysis/digit-circles';
import { subscribeLiveDigits, type DigitMarket } from '@/pages/digit-analysis/live-digits';
import '@/pages/digit-analysis/digit-analysis.scss';

export default function LiveDigits() {
    const [markets, setMarkets] = useState<DigitMarket[]>([]);
    const [symbol, setSymbol] = useState('R_100');
    const [sampleSize, setSampleSize] = useState(1000);
    const [digits, setDigits] = useState<number[]>([]);
    const [quote, setQuote] = useState('');
    const [status, setStatus] = useState('Connecting to market…');
    const [error, setError] = useState('');
    useEffect(() => {
        setDigits([]);
        setQuote('');
        return subscribeLiveDigits({
            symbol,
            sampleSize,
            onSnapshot: (next, latest) => {
                setDigits(next);
                setQuote(latest);
            },
            onMarkets: setMarkets,
            onStatus: (next, reason) => {
                setStatus(next);
                setError(reason);
            },
        });
    }, [symbol, sampleSize]);
    return (
        <div className='nl-digit-panel'>
            <div className='nl-digit-panel__controls'>
                <label>
                    Market
                    <select value={symbol} onChange={event => setSymbol(event.target.value)}>
                        {!markets.some(market => market.symbol === symbol) && <option value={symbol}>{symbol}</option>}
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
                <div>
                    <span>Latest quote</span>
                    <strong>{quote || '—'}</strong>
                </div>
                <div>
                    <span>Ticks in sample</span>
                    <strong>
                        {digits.length.toLocaleString()} / {sampleSize.toLocaleString()}
                    </strong>
                </div>
            </div>
            <p className='nl-digit-panel__status' role='status'>
                {status}
            </p>
            {error && (
                <p className='nl-digit-panel__error' role='alert'>
                    {error}
                </p>
            )}
            <DigitCircles digits={digits} />
            <p className='nl-digit-panel__note'>Percentages describe past ticks, not predictions of the next digit.</p>
        </div>
    );
}
