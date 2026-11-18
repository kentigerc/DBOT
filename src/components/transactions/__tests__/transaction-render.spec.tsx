import { fireEvent, render, screen } from '@testing-library/react';
import Transactions from '../transactions';
import { downloadFile } from '@/utils/download';
const mockKeys: string[][] = [];
const mockStore: any = {
    run_panel: { contract_stage: 0, is_running: false },
    journal: { filtered_messages: [] },
    transactions: { transactions: [], recoverPendingContracts: jest.fn(), toggleTransactionDetailsModal: jest.fn() },
};
jest.mock('@/hooks/useStore', () => ({ useStore: () => mockStore }));
jest.mock('@deriv-com/ui', () => ({ useDevice: () => ({ isDesktop: true }) }));
jest.mock('@deriv-com/translations', () => ({
    localize: (s: string) => s,
    Localize: ({ i18n_default_text }: any) => <>{i18n_default_text}</>,
}));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: () => ({ account_id: 'DOT_TEST' }) }));
jest.mock('@/external/bot-skeleton', () => ({
    getContractTypeName: (...args: any[]) =>
        jest.requireActual('@/external/bot-skeleton/utils/contract').getContractTypeName(...args),
}));
jest.mock('@/external/bot-skeleton/utils/workspace', () => ({ isDbotRTL: () => false }));
jest.mock('@/components/shared', () => ({
    formatMoney: (_currency: string, value: number) => value.toFixed(2),
    getCurrencyDisplayCode: (s: string) => s,
    isEmptyObject: (obj: any) => !obj || !Object.keys(obj).length,
    convertDateFormat: (s: any) => s,
}));
jest.mock('@/utils/download', () => ({ downloadFile: jest.fn() }));
jest.mock('@/components/market/market-icon', () => ({ MarketIcon: () => <svg /> }));
jest.mock('@/components/trade-type/trade-type-icon', () => ({ TradeTypeIcon: () => <svg /> }));
jest.mock('@/components/shared_ui/popover', () => ({
    __esModule: true,
    default: ({ children, message, is_open, className }: any) => (
        <div className={className}>
            {children}
            {is_open && message}
        </div>
    ),
}));
jest.mock('@/components/shared_ui/button', () => ({
    __esModule: true,
    default: ({ children, onClick, disabled }: any) => (
        <button onClick={onClick} disabled={disabled}>
            {children}
        </button>
    ),
}));
jest.mock('@/components/shared_ui/data-list', () => ({
    __esModule: true,
    default: ({ data_source, keyMapper, rowRenderer, getRowSize }: any) => {
        const keys = data_source.map(keyMapper);
        mockKeys.push(keys);
        return (
            <div>
                {data_source.map((row: any, i: number) => {
                    getRowSize({ index: i });
                    return <div key={keys[i]}>{rowRenderer({ row })}</div>;
                })}
            </div>
        );
    },
}));
beforeEach(() => {
    mockKeys.length = 0;
    mockStore.transactions.transactions = [
        {
            type: 'contract',
            data: {
                contract_id: 101,
                contract_type: 'DIGITOVER',
                underlying: 'R_100',
                currency: 'USD',
                status: 'won',
                is_completed: true,
                profit: 0.55,
                buy_price: 0.35,
            },
        },
        {
            type: 'contract',
            data: {
                contract_id: 102,
                contract_type: 'DIGITUNDER',
                underlying: 'R_10',
                currency: 'USD',
                status: 'lost',
                is_completed: true,
                profit: -0.35,
                buy_price: 0.35,
            },
        },
    ];
});
it('opens Transactions with confirmed contracts lacking optional broker references and shortcodes', () => {
    render(<Transactions is_drawer_open={false} />);
    expect(screen.getAllByTestId('dt_transactions_item')).toHaveLength(2);
    expect(mockKeys.at(-1)).toEqual(['contract:101', 'contract:102']);
    fireEvent.click(screen.getAllByTestId('dt_transactions_item')[0]);
    expect(screen.getByText('Contract ID')).toBeTruthy();
    expect(screen.getByText('101')).toBeTruthy();
});
it('exports those rows without inventing buy or sell references', () => {
    render(<Transactions is_drawer_open={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadFile).toHaveBeenCalledWith('Transactions', expect.stringContaining('0.35'));
    expect((downloadFile as jest.Mock).mock.calls[0][1]).not.toMatch(/undefined|null/);
});
it('keeps row identity stable when a broker buy reference arrives later', () => {
    const view = render(<Transactions is_drawer_open={false} />);
    mockStore.transactions.transactions = mockStore.transactions.transactions.map((row: any, i: number) => ({
        ...row,
        data: { ...row.data, transaction_ids: { buy: 9001 + i } },
    }));
    view.rerender(<Transactions is_drawer_open={true} />);
    expect(mockKeys.at(-1)).toEqual(['contract:101', 'contract:102']);
});
it.each([
    [{ contract_type: 'CALL', trade_type: 'higherlower' }, 'Higher'],
    [{ contract_type: 'PUT', trade_type: 'higherlower' }, 'Lower'],
    [{ contract_type: 'CALL', shortcode: 'CALL_R_100_S0P_0' }, 'Rise'],
    [{ contract_type: 'PUT', shortcode: 'PUT_R_100_S0P_0' }, 'Fall'],
    [{ contract_type: 'CALL', barrier: '123.45' }, 'Higher'],
    [{ contract_type: 'CALL' }, 'Unknown'],
    [{ contract_type: 'DIGITOVER' }, 'Over'],
    [null, 'Unknown'],
])('names incomplete and normal contract metadata safely: %s', (contract, expected) => {
    const { getContractTypeName } = jest.requireActual('@/external/bot-skeleton/utils/contract');
    expect(getContractTypeName(contract)).toBe(expected);
});
it('keeps real buy and sell reference IDs in ordinary history exports', () => {
    mockStore.transactions.transactions = [
        {
            type: 'contract',
            data: {
                contract_id: 301,
                contract_type: 'CALL',
                shortcode: 'CALL_R_100_S0P_0',
                transaction_ids: { buy: 9001, sell: 9002 },
                currency: 'USD',
                buy_price: 0.35,
                profit: 0.55,
                is_completed: true,
            },
        },
    ];
    render(<Transactions is_drawer_open={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadFile).toHaveBeenCalledWith('Transactions', expect.stringContaining('9001'));
    expect(downloadFile).toHaveBeenCalledWith('Transactions', expect.stringContaining('9002'));
});
