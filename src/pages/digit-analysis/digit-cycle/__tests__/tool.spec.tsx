import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { empty } from '@/services/digit-strategy/engine';
import { DEFAULT_SETTINGS } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DigitCycle from '..';

jest.mock('@/services/digit-strategy/client', () => ({
    digitStrategyEngine: {
        subscribe: jest.fn(() => () => {}),
        getSnapshot: jest.fn(),
        selectAccount: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        reset: jest.fn().mockResolvedValue(undefined),
    },
}));
jest.mock('@/utils/deriv-session', () => ({ getDerivAccount: jest.fn(), getDerivSession: jest.fn() }));
const client = digitStrategyEngine as unknown as {
    start: jest.Mock;
    stop: jest.Mock;
    reset: jest.Mock;
    getSnapshot: jest.Mock;
};
beforeEach(() => {
    jest.clearAllMocks();
    client.getSnapshot.mockReturnValue({ ...empty(), settings: { ...DEFAULT_SETTINGS, strategy: 'over2-under7' } });
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true, accounts: [] });
    (getDerivAccount as jest.Mock).mockReturnValue({ account_id: 'DEMO', account_type: 'demo', currency: 'USD' });
});
it('exposes the requested settings and starts the named strategy only on RUN', async () => {
    render(<DigitCycle />);
    expect(screen.getByRole('heading', { name: 'HIT AND RUN STRATEGY' })).toBeTruthy();
    expect(client.start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Martingale multiplier'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    await waitFor(() =>
        expect(client.start).toHaveBeenCalledWith(
            expect.objectContaining({
                strategy: 'over2-under7',
                duration: 2,
                multiplier: 3,
                stake: 0.35,
                maxLosses: 5,
                maxStake: 100,
                stopLoss: 100,
            }),
            undefined
        )
    );
});
it('does not allow a logged-out user to start', () => {
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: false, accounts: [] });
    render(<DigitCycle />);
    expect((screen.getByRole('button', { name: 'RUN' }) as HTMLButtonElement).disabled).toBe(true);
});
it('prevents starting or controlling a different active tool', () => {
    client.getSnapshot.mockReturnValue({ ...empty(), active: true });
    render(<DigitCycle />);
    expect((screen.getByRole('button', { name: 'RUN' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'STOP' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset stopped session' }) as HTMLButtonElement).disabled).toBe(true);
});
it('stops its active session and locks risk settings', async () => {
    const snapshot = client.getSnapshot();
    client.getSnapshot.mockReturnValue({ ...snapshot, active: true });
    render(<DigitCycle />);
    expect((screen.getByLabelText('Starting stake (USD)') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'STOP' }));
    await waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
});
it('shows command failures without pretending trading started', async () => {
    client.start.mockRejectedValueOnce(new Error('Risk settings invalid'));
    render(<DigitCycle />);
    fireEvent.click(screen.getByRole('button', { name: 'RUN' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Risk settings invalid');
});
