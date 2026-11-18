import { observable, runInAction } from 'mobx';
import { getStoredItemsByKey, setStoredItemsByKey } from '../../utils/session-storage';
import TransactionsStore from '../transactions-store';
let mockSnapshot: any = { accountId: '', history: [] };
const mockListeners = new Set<() => void>();
jest.mock('@/utils/higher-lower-builder', () => ({
    higherLowerBuilder: {
        getSnapshot: () => mockSnapshot,
        subscribe: (fn: () => void) => {
            mockListeners.add(fn);
            return () => mockListeners.delete(fn);
        },
    },
}));
jest.mock('@/components/shared', () => ({
    formatDate: (value: unknown) => String(value),
    isEnded: (c: any) => c.status && c.status !== 'open',
}));
jest.mock('@/external/bot-skeleton', () => ({ LogTypes: {} }));
jest.mock('../../utils/session-storage', () => ({
    getStoredItemsByKey: jest.fn((_k: string, fallback: any) => fallback),
    getStoredItemsByUser: () => [],
    setStoredItemsByKey: jest.fn(),
}));
const leg = (id: number, type: string, profit?: number) => ({
    id,
    type,
    status: profit === undefined ? 'open' : 'settled',
    profit,
    buyPrice: 35,
    payout: profit === undefined ? undefined : 35 + profit,
    contract: { contract_id: id, date_start: 123, transaction_ids: { buy: id + 1000 } },
});
const publish = (value: any) => {
    mockSnapshot = value;
    mockListeners.forEach(fn => fn());
};
function setup() {
    mockListeners.clear();
    mockSnapshot = { accountId: '', history: [] };
    const client = observable({ loginid: 'DOT_A' });
    const root: any = { run_panel: { run_id: 'normal' }, summary_card: {}, journal: {} };
    const store = new TransactionsStore(root, { client } as any);
    return { store, client };
}
it('puts both confirmed legs into Transactions and updates results without duplicates', () => {
    const { store } = setup();
    try {
        publish({
            accountId: 'DOT_A',
            pending: { symbol: 'R_100', at: 1, legs: [leg(101, 'HIGHER'), leg(102, 'LOWER')] },
        });
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(2);
        expect(store.statistics).toMatchObject({ number_of_runs: 0 });
        const state = {
            accountId: 'DOT_A',
            history: [{ symbol: 'R_100', at: 1, legs: [leg(101, 'HIGHER', 55), leg(102, 'LOWER', -35)] }],
        };
        publish(state);
        const savedCalls = (setStoredItemsByKey as jest.Mock).mock.calls.length;
        publish(state);
        expect((setStoredItemsByKey as jest.Mock).mock.calls).toHaveLength(savedCalls);
        const saved = (setStoredItemsByKey as jest.Mock).mock.calls.at(-1)?.[1].DOT_A;
        expect(saved.filter((row: any) => row.type === 'contract' && row.data.is_completed)).toHaveLength(2);
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(2);
        expect(store.statistics).toMatchObject({ number_of_runs: 2, won_contracts: 1, lost_contracts: 1 });
        expect(store.statistics.total_profit).toBeCloseTo(0.2);
        store.pushTransaction({ contract_id: 101, transaction_ids: { buy: 1101 }, status: 'open' } as any);
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(2);
        expect(store.statistics.number_of_runs).toBe(2);
    } finally {
        store.disposeReactionsFn();
    }
});
it('does not invent rows for rejected or unknown purchases and keeps accounts separate', () => {
    const { store, client } = setup();
    try {
        publish({
            accountId: 'DOT_B',
            pending: { symbol: 'R_50', legs: [leg(201, 'HIGHER'), { type: 'LOWER', status: 'unknown' }] },
        });
        expect(store.transactions).toHaveLength(0);
        runInAction(() => {
            client.loginid = 'DOT_B';
        });
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(1);
        runInAction(() => {
            client.loginid = 'DOT_A';
        });
        expect(store.transactions).toHaveLength(0);
    } finally {
        store.disposeReactionsFn();
    }
});
it('deduplicates a broker event without a buy reference against its paired contract ID', () => {
    const { store } = setup();
    try {
        store.pushTransaction({ contract_id: 101, status: 'open' } as any);
        publish({ accountId: 'DOT_A', pending: { symbol: 'R_100', legs: [leg(101, 'HIGHER'), leg(102, 'LOWER')] } });
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(2);
    } finally {
        store.disposeReactionsFn();
    }
});

it('restores saved transactions for the selected account after a reload', () => {
    (getStoredItemsByKey as jest.Mock).mockReturnValueOnce({
        DOT_A: [{ type: 'contract', data: { contract_id: 301, is_completed: true, profit: 0.55, buy_price: 0.35 } }],
        DOT_B: [{ type: 'contract', data: { contract_id: 999 } }],
    });
    const { store } = setup();
    try {
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(1);
        expect((store.transactions[0].data as any).contract_id).toBe(301);
    } finally {
        store.disposeReactionsFn();
    }
});
it('counts refunded legs without falsely marking them lost and uses actual returned amounts', () => {
    const { store } = setup();
    try {
        publish({
            accountId: 'DOT_A',
            history: [{ symbol: 'R_100', at: 1, legs: [leg(101, 'HIGHER', 0), leg(102, 'LOWER', 0)] }],
        });
        expect(store.statistics).toMatchObject({
            number_of_runs: 2,
            won_contracts: 0,
            lost_contracts: 0,
            total_profit: 0,
        });
        expect(store.statistics.total_payout).toBeCloseTo(0.7);
    } finally {
        store.disposeReactionsFn();
    }
});
