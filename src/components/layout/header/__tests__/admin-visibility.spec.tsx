import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getDerivSession, refreshDerivSession, type DerivSession } from '@/utils/deriv-session';
import Header from '../header';
jest.mock('@/components/currency/currency-icon', () => ({ CurrencyIcon: () => null }));
jest.mock('@/external/bot-skeleton', () => ({ api_base: { is_running: false } }));
jest.mock('@/hooks/useStore', () => ({ useStore: () => ({ client: {} }) }));
jest.mock('@/hooks/useThemeSwitcher', () => ({
    __esModule: true,
    default: () => ({ is_dark_mode_on: false, toggleTheme: jest.fn() }),
}));
jest.mock('@/utils/deriv-session', () => ({
    getDerivSession: jest.fn(),
    refreshDerivSession: jest.fn(),
    logoutDerivSession: jest.fn(),
    startDerivLogin: jest.fn(),
}));
jest.mock('@/utils/site-config', () => ({ affiliate_signup_url: 'https://example.test' }));
jest.mock('@/utils/trading-lock', () => ({ isAnalysisTrading: () => false }));
jest.mock('../../app-logo', () => ({ AppLogo: () => null }));
const owner = {
    account_id: 'ROT91643925',
    account_type: 'demo' as const,
    currency: 'USD',
    status: 'active',
    balance: 100,
};
const visitor = { ...owner, account_id: 'OTHER-DEMO' };
const session = (data: Partial<DerivSession> = {}): DerivSession => ({
    authenticated: true,
    accounts: [owner],
    isAdmin: true,
    adminAccounts: [owner.account_id],
    ...data,
});
beforeEach(() => {
    localStorage.clear();
    (refreshDerivSession as jest.Mock).mockResolvedValue(undefined);
});
const show = (data: DerivSession) => {
    (getDerivSession as jest.Mock).mockReturnValue(data);
    return render(
        <MemoryRouter>
            <Header />
        </MemoryRouter>
    );
};
it('shows the verified owner an Analytics link immediately after Trading Bots', () => {
    localStorage.setItem('neto.account_id', owner.account_id);
    show(session());
    const analytics = screen.getByRole('link', { name: 'Analytics' });
    expect(analytics).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('link', { name: 'Trading Bots' }).nextElementSibling).toBe(analytics);
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
it.each([
    session({ authenticated: false }),
    session({ accounts: [visitor], isAdmin: false, adminAccounts: [] }),
    session({ adminAccounts: undefined }),
    session({ isAdmin: false }),
    session({ accounts: [{ ...owner, status: 'disabled' }] }),
    session({ accounts: [visitor], adminAccounts: [owner.account_id] }),
])('hides Analytics from guests, non-owners and unconfirmed sessions', data => {
    show(data);
    expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
});
it('keeps Analytics available on the owner’s linked real account', () => {
    const real = { ...owner, account_id: 'CR123456', account_type: 'real' as const };
    const data = session({ accounts: [owner, real] });
    localStorage.setItem('neto.account_id', owner.account_id);
    show(data);
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeTruthy();
    localStorage.setItem('neto.account_id', real.account_id);
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeTruthy();
    localStorage.setItem('neto.account_id', owner.account_id);
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.getByRole('link', { name: 'Analytics' })).toBeTruthy();
});
it('keeps Analytics hidden for non-owner real accounts, even with a forged local selection', () => {
    localStorage.setItem('neto.account_id', owner.account_id);
    show(session({ accounts: [{ ...visitor, account_type: 'real' }], isAdmin: false, adminAccounts: [] }));
    expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
});
it('updates the link when login identifies the owner and removes it on logout', () => {
    show(session({ authenticated: false, accounts: [], isAdmin: false, adminAccounts: [] }));
    expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
    (getDerivSession as jest.Mock).mockReturnValue(session());
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/admin');
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: false, accounts: [] });
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.queryByRole('link', { name: 'Analytics' })).toBeNull();
});
