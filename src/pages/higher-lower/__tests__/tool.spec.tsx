import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HigherLower from '..';
import { getDerivAccount, sessionRequest } from '@/utils/deriv-session';
import { PAIR_DEFAULTS } from '../xml';
jest.mock('@/hooks/useMarketPanelHeight', () => ({ __esModule: true, default: () => null }));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn(), sessionRequest: jest.fn() }));
const request = sessionRequest as jest.Mock;
const snapshot = (source = 'analysis') => ({
    source,
    accountId: 'DOT_TEST',
    active: false,
    settings: PAIR_DEFAULTS,
    pnl: 0,
    pairs: 0,
    history: [],
    message: `${source} ready`,
});
beforeEach(() => {
    jest.clearAllMocks();
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DOT_TEST', account_type: 'demo', currency: 'USD' });
    request.mockImplementation(async url => snapshot(url.includes('source=xml') ? 'xml' : 'analysis'));
});
it('starts a demo session only after an explicit click and passes the selected settings', async () => {
    render(<HigherLower />);
    await screen.findByText('analysis ready');
    expect(request.mock.calls.every(c => c[1] === undefined)).toBe(true);
    fireEvent.change(screen.getByLabelText('Stake per side (USD)'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'RUN HIGHER / LOWER' }));
    await waitFor(() =>
        expect(request).toHaveBeenCalledWith(expect.stringContaining('source=analysis'), {
            command: 'start',
            settings: { ...PAIR_DEFAULTS, stake: 0.5 },
        })
    );
});
it('blocks real-account execution in the interface as well as on the server', async () => {
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'CR_TEST', account_type: 'real', currency: 'USD' });
    render(<HigherLower />);
    expect(screen.getByRole('button', { name: 'RUN HIGHER / LOWER' })).toBeDisabled();
});
it('never projects the analysis session into the standalone XML runner', async () => {
    const original = global.fetch;
    global.fetch = jest
        .fn()
        .mockResolvedValue({
            ok: true,
            text: async () =>
                '<xml><block type="neto_higher_lower_pair"><field name="STAKE">0.35</field><field name="DURATION">5</field><field name="STOP_LOSS">10</field><field name="TAKE_PROFIT">5</field><field name="MAX_PAIRS">10</field></block></xml>',
        });
    request.mockImplementation(async url =>
        url.includes('source=xml')
            ? snapshot('xml')
            : { ...snapshot(), active: true, pnl: 999, message: 'analysis active' }
    );
    try {
        render(
            <>
                <HigherLower />
                <HigherLower source='xml' />
            </>
        );
        await screen.findByText('analysis active');
        await screen.findByText('xml ready');
        expect(screen.getByRole('button', { name: 'RUN XML BOT' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'RUN HIGHER / LOWER' })).toBeDisabled();
        expect(request.mock.calls.every(c => c[1] === undefined)).toBe(true);
    } finally {
        global.fetch = original;
    }
});
