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
it('keeps Admin out of navigation even for the owner demo account', () => {
    localStorage.setItem('neto.account_id', owner.account_id);
    show(session());
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
it.each([
    session({ authenticated: false }),
    session({ accounts: [visitor], isAdmin: false, adminAccounts: [] }),
    session({ adminAccounts: undefined }),
    session({ isAdmin: false }),
    session({ accounts: [{ ...owner, status: 'disabled' }] }),
])('hides Admin from guests, non-owners and unconfirmed sessions', data => {
    show(data);
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
it('hides Admin when a different account is selected, even if the owner account is linked', () => {
    localStorage.setItem('neto.account_id', visitor.account_id);
    show(session({ accounts: [owner, visitor] }));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
it('keeps Admin hidden when switching between demo and real accounts', () => {
    const real = { ...owner, account_id: 'CR123456', account_type: 'real' as const };
    const accounts = [owner, real];
    const data = session({ accounts, adminAccounts: accounts.map(account => account.account_id) });
    localStorage.setItem('neto.account_id', owner.account_id);
    show(data);
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    localStorage.setItem('neto.account_id', real.account_id);
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Bot Builder' })).toBeTruthy();
    localStorage.setItem('neto.account_id', owner.account_id);
    act(() => window.dispatchEvent(new Event('neto-session')));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
it('keeps Admin hidden for non-owner real accounts', () => {
    show(session({ accounts: [{ ...visitor, account_type: 'real' }], isAdmin: false, adminAccounts: [] }));
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
