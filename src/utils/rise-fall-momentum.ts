export const RISE_FALL_BOT_FILE = 'neto-risefall-alternating-recovery.xml';
export const RISE_FALL_BOT_NAME = 'NETO Rise/Fall Alternating Recovery';
export const MOMENTUM_MARKER = 'netoacademy:rise-fall-momentum';
export const MOMENTUM_HISTORY = 1000;
export type MomentumDirection = 'CALL' | 'PUT';
export type MomentumDuration = 1 | 5;

type MarketRequest = (request: Record<string, unknown>) => Promise<{
    history?: { prices?: number[]; times?: number[] };
    proposal?: { ask_price?: number | string; payout?: number | string };
}>;

const windowSize = 20;
function directionAt(prices: number[], index: number): MomentumDirection | undefined {
    const long = prices[index] - prices[index - windowSize];
    const short = prices[index] - prices[index - 5];
    if (short > 0 && long > 0) return 'CALL';
    if (short < 0 && long < 0) return 'PUT';
}

export function scoreMomentum(prices: number[], duration: MomentumDuration) {
    const latest = prices.length - 1;
    const direction = directionAt(prices, latest);
    if (!direction) return;
    let samples = 0;
    let wins = 0;
    for (let index = windowSize; index + duration < latest; index++) {
        if (directionAt(prices, index) !== direction) continue;
        samples++;
        const movement = prices[index + duration] - prices[index];
        if (direction === 'CALL' ? movement > 0 : movement < 0) wins++;
        index += duration - 1;
    }
    if (samples < 50) return;
    const winRate = wins / samples;
    const z = 1.96;
    const variance = (winRate * (1 - winRate) + z * z / (4 * samples)) / samples;
    const lowerBound = (winRate + z * z / (2 * samples) - z * Math.sqrt(variance)) / (1 + z * z / samples);
    return { direction, samples, winRate, lowerBound };
}

export async function checkMomentumEntry(
    send: MarketRequest,
    symbol: string,
    duration: MomentumDuration,
    currency: string,
    amount: number,
    requiredDirection?: MomentumDirection
) {
    const request = async (body: Record<string, unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                send(body),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Deriv did not respond in time.')), 5000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const { history } = await request({ ticks_history: symbol, count: MOMENTUM_HISTORY, end: 'latest', style: 'ticks' });
    const prices = history?.prices?.map(Number);
    const epoch = Number(history?.times?.slice(-1)[0]);
    const fresh = () => Date.now() / 1000 - epoch >= -2 && Date.now() / 1000 - epoch <= 4;
    if (!prices || !prices.every(Number.isFinite) || !fresh())
        throw new Error('Fresh price history is unavailable.');
    const reading = scoreMomentum(prices, duration);
    if (!reading || (requiredDirection && reading.direction !== requiredDirection)) return;
    const { proposal } = await request({
        proposal: 1, symbol, duration, duration_unit: 't', basis: 'stake', currency, amount,
        contract_type: reading.direction,
    });
    const price = Number(proposal?.ask_price);
    const payout = Number(proposal?.payout);
    if (!Number.isFinite(price) || !Number.isFinite(payout) || price <= 0 || payout <= price)
        throw new Error('Deriv did not return an available Rise/Fall quote.');
    const breakEven = price / payout;
    return { ...reading, breakEven, qualified: fresh() && reading.lowerBound > breakEven + 0.01, fresh };
}

export function configureMomentumBot(content: string, direction: unknown, duration: unknown) {
    if ((direction !== 'CALL' && direction !== 'PUT') || (duration !== 1 && duration !== 5))
        throw new Error('Invalid Rise/Fall momentum selection.');
    const document = new DOMParser().parseFromString(content, 'text/xml');
    const preference = document.querySelector('block[type="variables_set"] > field[id="Preferred"]');
    const initialDirection = preference?.parentElement?.querySelector('value[name="VALUE"] field[name="NUM"]');
    const ticks = document.querySelector('block[type="trade_definition_tradeoptions"] > value[name="DURATION"] field[name="NUM"]');
    const marker = document.querySelector('block[type="trade_definition"] > data');
    if (!initialDirection || !ticks || !marker) throw new Error('The Rise/Fall bot has incomplete settings.');
    initialDirection.textContent = direction === 'CALL' ? '0' : '1';
    ticks.textContent = String(duration);
    marker.textContent += ' ' + MOMENTUM_MARKER;
    return new XMLSerializer().serializeToString(document);
}
