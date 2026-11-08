import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { getDerivSession, refreshDerivSession, startDerivLogin } from '@/utils/deriv-session';
import Landing from '..';
jest.mock('@/utils/deriv-session', () => ({
    getDerivSession: jest.fn(),
    refreshDerivSession: jest.fn(),
    startDerivLogin: jest.fn(),
}));
jest.mock('@/components/usage-tracker', () => () => null);
jest.mock('../components/live-digits', () => ({
    __esModule: true,
    default: () => <div data-testid='live-digits' />,
}));
const show = (path = '/') =>
    render(
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
                <Route path='/' element={<Landing />} />
                <Route path='/platform' element={<Location />} />
            </Routes>
        </MemoryRouter>
    );
function Location() {
    const location = useLocation();
    return (
        <p>
            {location.pathname}
            {location.hash}
        </p>
    );
}
beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: false, accounts: [] });
    (refreshDerivSession as jest.Mock).mockResolvedValue({ authenticated: false, accounts: [] });
});
it('provides a clear platform entry without starting trading or requiring authentication', () => {
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('A clearer way');
    expect(screen.getByRole('link', { name: /Launch trading platform/ }).getAttribute('href')).toBe(
        '/platform#bot_builder'
    );
    expect(screen.getByLabelText('Illustrative NetoAcademy workspace preview')).toBeTruthy();
    expect(startDerivLogin).not.toHaveBeenCalled();
});
it('uses the existing Deriv authorization flow and welcomes connected accounts', () => {
    const { unmount } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Log in with Deriv' }));
    expect(startDerivLogin).toHaveBeenCalledTimes(1);
    unmount();
    (getDerivSession as jest.Mock).mockReturnValue({ authenticated: true, accounts: [] });
    show();
    expect(screen.getByRole('link', { name: /Enter your workspace/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Log in with Deriv' })).toBeNull();
});
it.each(['bot_builder', 'digit_analysis', 'deriv_charts', 'analysis_tool', 'risk_calculator'])(
    'preserves legacy #%s platform bookmarks',
    hash => {
        show('/#' + hash);
        expect(screen.getByText('/platform#' + hash)).toBeTruthy();
    }
);
it('keeps landing-page section anchors on the landing page and includes risk disclosures', () => {
    show('/#questions');
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByText(/Trading involves risk/)).toBeTruthy();
    expect(screen.getByText(/independent third-party platform and is not operated by Deriv/)).toBeTruthy();
});

it('persists the selected theme across landing visits and applies it to the shared platform theme', () => {
    const { unmount } = show();
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.body.classList.contains('theme--light')).toBe(true);
    expect(document.querySelector('.neto-landing--light')).toBeTruthy();
    unmount();
    show();
    expect(screen.getByRole('switch', { name: 'Dark mode' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }));
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.body.classList.contains('theme--dark')).toBe(true);
    expect(document.querySelector('.neto-landing--light')).toBeNull();
});

it('shows live digit circles below the top bar and retains them when switching theme', async () => {
    show();
    const chart = await screen.findByTestId('live-digits');
    expect(document.querySelector('#nl-main')?.firstElementChild?.getAttribute('aria-label')).toBe(
        'Live Deriv digit analysis'
    );
    expect(screen.getByRole('link', { name: /Open digit analysis/ }).getAttribute('href')).toBe(
        '/platform#digit_analysis'
    );
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }));
    expect(screen.getByTestId('live-digits')).toBe(chart);
    expect(document.querySelector('.neto-landing--light')).toBeTruthy();
});
