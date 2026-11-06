import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TermsGate from '..';
import { refreshDerivSession, sessionRequest } from '@/utils/deriv-session';
import terms from '../../../../config/terms.json';
let mockSession: any;
jest.mock('@/utils/deriv-session', () => ({
    getDerivSession: () => mockSession,
    refreshDerivSession: jest.fn(),
    sessionRequest: jest.fn(),
}));
const show = () =>
    render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <TermsGate>
                <p>Trading workspace</p>
            </TermsGate>
        </MemoryRouter>
    );
beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { authenticated: true, accounts: [], termsAccepted: false, termsVersion: terms.version };
    (refreshDerivSession as jest.Mock).mockImplementation(async () => {
        window.dispatchEvent(new Event('neto-session'));
        return mockSession;
    });
    (sessionRequest as jest.Mock).mockImplementation(async () => {
        mockSession = { ...mockSession, termsAccepted: true };
        return {};
    });
});
it('requires an explicit checkbox and successful server acceptance before mounting the workspace', async () => {
    show();
    const accept = await screen.findByRole('button', { name: 'Accept & enter workspace' });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Trading workspace')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(accept);
    await screen.findByText('Trading workspace');
    expect(sessionRequest).toHaveBeenCalledWith('/api/auth/terms', { accepted: true, version: terms.version });
});
it('does not prompt again on workspace return, but does after a new login without acceptance', async () => {
    mockSession.termsAccepted = true;
    const first = show();
    await screen.findByText('Trading workspace');
    expect(screen.queryByRole('checkbox')).toBeNull();
    first.unmount();
    const second = show();
    await screen.findByText('Trading workspace');
    expect(screen.queryByRole('checkbox')).toBeNull();
    second.unmount();
    mockSession.termsAccepted = false;
    show();
    await screen.findByRole('checkbox');
    expect(screen.queryByText('Trading workspace')).toBeNull();
});
it('keeps the popup open if recording acceptance fails', async () => {
    (sessionRequest as jest.Mock).mockRejectedValueOnce(new Error('Connection failed'));
    show();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept & enter workspace' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Connection failed');
    expect(screen.queryByText('Trading workspace')).toBeNull();
});
it('preserves public guest previews without pretending acceptance has been recorded', async () => {
    mockSession.authenticated = false;
    show();
    await screen.findByText('Trading workspace');
    expect(sessionRequest).not.toHaveBeenCalled();
});

it('recognizes acceptance in another tab of the same login when returning to this tab', async () => {
    show();
    await screen.findByRole('checkbox');
    mockSession = { ...mockSession, termsAccepted: true };
    await act(async () => window.dispatchEvent(new Event('focus')));
    await screen.findByText('Trading workspace');
    expect(sessionRequest).not.toHaveBeenCalled();
});
