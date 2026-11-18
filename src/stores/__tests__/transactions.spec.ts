import { observable, runInAction } from 'mobx';
import { getStoredItemsByKey, setStoredItemsByKey } from '../../utils/session-storage';
import TransactionsStore from '../transactions-store';
jest.mock('@/components/shared', () => ({
    formatDate: (value: unknown) => String(value),
    isEnded: (c: any) => c.status && c.status !== 'open',
}));
jest.mock('@/external/bot-skeleton', () => ({ LogTypes: {} }));
jest.mock('../../utils/session-storage', () => ({
    getStoredItemsByKey: jest.fn((_k: string, fallback: any) => fallback),
    setStoredItemsByKey: jest.fn(),
}));
function setup() {
    const client = observable({ loginid: 'DOT_A' });
    const root: any = { run_panel: { run_id: 'normal' }, summary_card: {}, journal: {} };
    return { store: new TransactionsStore(root, { client } as any), client };
}
it('updates transactions by confirmed contract ID without a buy reference or duplicate rows', () => {
    const { store } = setup();
    try {
        store.pushTransaction({ contract_id: 101, status: 'open', buy_price: 0.35 } as any);
        store.pushTransaction({
            contract_id: 101,
            transaction_ids: { buy: 9001 },
            status: 'won',
            profit: 0.55,
            buy_price: 0.35,
        } as any);
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(1);
        expect(store.statistics).toMatchObject({ number_of_runs: 1, won_contracts: 1, total_profit: 0.55 });
        store.pushTransaction({ contract_id: 101, status: 'open' } as any);
        expect(store.statistics.number_of_runs).toBe(1);
    } finally {
        store.disposeReactionsFn();
    }
});
it('persists settlement updates after observable transaction changes', () => {
    const { store } = setup();
    try {
        store.pushTransaction({ contract_id: 101, status: 'open' } as any);
        store.pushTransaction({ contract_id: 101, status: 'lost', profit: -0.35 } as any);
        const saved = (setStoredItemsByKey as jest.Mock).mock.calls.at(-1)?.[1].DOT_A;
        expect(saved.filter((t: any) => t.type === 'contract' && t.data.is_completed)).toHaveLength(1);
    } finally {
        store.disposeReactionsFn();
    }
});
it('keeps transaction views scoped to the selected account', () => {
    const { store, client } = setup();
    try {
        store.pushTransaction({ contract_id: 101, status: 'open' } as any);
        runInAction(() => {
            client.loginid = 'DOT_B';
        });
        expect(store.transactions).toHaveLength(0);
        runInAction(() => {
            client.loginid = 'DOT_A';
        });
        expect(store.transactions.filter(t => t.type === 'contract')).toHaveLength(1);
    } finally {
        store.disposeReactionsFn();
    }
});
it('restores saved transactions for the selected account after reload', () => {
    (getStoredItemsByKey as jest.Mock).mockReturnValueOnce({
        DOT_A: [{ type: 'contract', data: { contract_id: 301 } }],
        DOT_B: [{ type: 'contract', data: { contract_id: 999 } }],
    });
    const { store } = setup();
    try {
        expect((store.transactions[0].data as any).contract_id).toBe(301);
        expect(store.transactions).toHaveLength(1);
    } finally {
        store.disposeReactionsFn();
    }
});
it('counts refunds without marking them lost and uses actual returns', () => {
    const { store } = setup();
    try {
        store.pushTransaction({
            contract_id: 101,
            status: 'sold',
            profit: 0,
            buy_price: 0.35,
            sell_price: 0.35,
        } as any);
        expect(store.statistics).toMatchObject({
            number_of_runs: 1,
            won_contracts: 0,
            lost_contracts: 0,
            total_profit: 0,
            total_payout: 0.35,
        });
    } finally {
        store.disposeReactionsFn();
    }
});
