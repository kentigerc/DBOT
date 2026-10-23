import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { lastDigit } from './digits';

export type DigitMarket = {
    symbol: string;
    display_name: string;
    market: string;
    exchange_is_open: number;
    is_trading_suspended: number;
};
type Tick = { quote: number; epoch: number; pip_size?: number; symbol?: string; underlying_symbol?: string };
type Api = Awaited<ReturnType<typeof generateDerivApiInstance>>;

// One live subscription. Recover with fresh history so ticks missed offline aren't guessed.
export function subscribeLiveDigits({
    symbol,
    sampleSize,
    onSnapshot,
    onMarkets,
    onStatus,
}: {
    symbol: string;
    sampleSize: number;
    onSnapshot: (digits: number[], latest: string) => void;
    onMarkets: (markets: DigitMarket[]) => void;
    onStatus: (status: string, error: string) => void;
}) {
    let disposed = false;
    let generation = 0;
    let failures = 0;
    let api: Api | undefined;
    let listener: { unsubscribe: () => void } | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let lastUpdate = 0;
    const release = () => {
        clearTimeout(retry);
        clearInterval(watchdog);
        listener?.unsubscribe();
        listener = undefined;
        const previous = api;
        api = undefined;
        previous?.disconnect();
    };
    const connect = () => {
        if (disposed) return;
        const current = ++generation;
        release();
        if (!navigator.onLine) {
            onStatus('Offline', 'You are offline. Live digits will resume automatically when your connection returns.');
            return;
        }
        let failed = false;
        let ready = false;
        let precision = 0;
        let epoch = 0;
        let digits: number[] = [];
        const queued: Tick[] = [];
        const valid = () => !disposed && generation === current && !failed;
        onStatus(
            failures ? 'Reconnecting…' : 'Connecting to market…',
            failures ? 'Restoring live data automatically. Displayed percentages are the last received snapshot.' : ''
        );
        lastUpdate = Date.now();
        const fail = (reason: string) => {
            if (!valid()) return;
            failed = true;
            generation++;
            release();
            const seconds = Math.min(15, 2 ** Math.min(failures++, 4));
            onStatus(
                'Reconnecting…',
                `${reason} Retrying automatically in ${seconds}s. Displayed percentages are the last received snapshot.`
            );
            retry = setTimeout(connect, seconds * 1000);
        };
        const accept = (tick: Tick) => {
            if (!valid() || !Number.isFinite(tick.epoch) || tick.epoch <= epoch) return;
            const pip = Number.isInteger(tick.pip_size) ? tick.pip_size! : precision;
            const digit = lastDigit(tick.quote, pip);
            if (digit === null) return;
            epoch = tick.epoch;
            digits = [...digits, digit].slice(-sampleSize);
            lastUpdate = Date.now();
            onSnapshot([...digits], Number(tick.quote).toFixed(pip));
            onStatus('Live', '');
        };
        watchdog = setInterval(() => {
            if (Date.now() - lastUpdate > (ready ? 12000 : 15000)) fail('Live market data stopped updating.');
        }, 1000);
        const start = async () => {
            const instance = await generateDerivApiInstance({ publicOnly: true });
            if (!valid()) {
                instance.disconnect();
                return;
            }
            api = instance;
            instance.connection.addEventListener('close', () => fail('Market connection closed.'));
            instance.connection.addEventListener('error', () => fail('Unable to receive live market data.'));
            listener = instance
                .onMessage()
                .subscribe(({ data }: { data: { tick?: Tick; error?: { message?: string } } }) => {
                    if (!valid()) return;
                    if (data.error) {
                        fail(data.error.message || 'Market data unavailable.');
                        return;
                    }
                    if (!data.tick) return;
                    const tickSymbol = data.tick.symbol || data.tick.underlying_symbol;
                    if (tickSymbol && tickSymbol !== symbol) return;
                    if (!ready) queued.push(data.tick);
                    else accept(data.tick);
                });
            const [symbols, history] = await Promise.all([
                instance.send({ active_symbols: 'brief' }),
                instance.send({
                    ticks_history: symbol,
                    style: 'ticks',
                    end: 'latest',
                    count: sampleSize,
                    subscribe: 1,
                }),
            ]);
            if (!valid()) return;
            if (
                !Array.isArray(history.history?.prices) ||
                !Number.isInteger(history.pip_size) ||
                !Array.isArray(symbols.active_symbols)
            )
                throw new Error('Market history is unavailable.');
            precision = history.pip_size;
            const prices = history.history.prices as number[];
            digits = prices
                .map(price => lastDigit(price, precision))
                .filter((digit): digit is number => digit !== null)
                .slice(-sampleSize);
            if (!digits.length) throw new Error('No market ticks are available.');
            const times = history.history.times as number[] | undefined;
            epoch = times?.[times.length - 1] || 0;
            onMarkets(
                symbols.active_symbols.filter(
                    (market: DigitMarket) =>
                        market.market === 'synthetic_index' && market.exchange_is_open && !market.is_trading_suspended
                )
            );
            onSnapshot([...digits], Number(prices[prices.length - 1]).toFixed(precision));
            lastUpdate = Date.now();
            failures = 0;
            ready = true;
            onStatus('Live', '');
            queued.forEach(accept);
        };
        void start().catch(error => fail(error?.message || 'Unable to load live market data.'));
    };
    const offline = () => {
        if (disposed) return;
        generation++;
        release();
        onStatus('Offline', 'You are offline. Live digits will resume automatically when your connection returns.');
    };
    const visible = () => {
        if (!document.hidden && Date.now() - lastUpdate > 12000) connect();
    };
    window.addEventListener('online', connect);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    connect();
    return () => {
        disposed = true;
        generation++;
        release();
        window.removeEventListener('online', connect);
        window.removeEventListener('offline', offline);
        document.removeEventListener('visibilitychange', visible);
    };
}
