import { fireEvent, render, screen, within } from '@testing-library/react';
import FreeBots from '..';
const mockNavigate = jest.fn(),
    mockSetActiveTab = jest.fn();
jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('@/hooks/useMarketPanelHeight', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useStore', () => ({
    useStore: () => ({ dashboard: { setActiveTab: mockSetActiveTab }, run_panel: { is_running: false } }),
}));
jest.mock('@/utils/deriv-session', () => ({ getDerivSession: () => ({ authenticated: true }) }));
it('lists the existing XML bots and loads the selected bot into the existing Bot Builder', () => {
    render(<FreeBots />);
    expect(document.querySelectorAll('.free-bots__card')).toHaveLength(5);
    const cards = screen.getAllByRole('heading', { name: 'Over Switcher' });
    expect(cards).toHaveLength(1);
    fireEvent.click(
        within(cards[0].closest('.free-bots__card') as HTMLElement).getByRole('button', { name: 'Load Bot' })
    );
    expect(mockNavigate).toHaveBeenCalledWith('/platform#bot_builder');
    expect(mockSetActiveTab).toHaveBeenCalledWith(1);
    expect(JSON.parse(sessionStorage.getItem('neto.pendingBot') || '{}')).toEqual({
        fileName: 'over-1-over-0.xml',
        name: 'Over Switcher',
    });
});

it('loads the Rise/Fall bot through the standard Bot Builder route', () => {
    render(<FreeBots />);
    const card = screen
        .getByRole('heading', { name: 'Rise and fall Auto V1' })
        .closest('.free-bots__card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Load Bot' }));
    expect(mockNavigate).toHaveBeenCalledWith('/platform#bot_builder');
    expect(JSON.parse(sessionStorage.getItem('neto.pendingBot') || '{}')).toEqual({
        fileName: 'neto-risefall-alternating-recovery.xml',
        name: 'Rise and fall Auto V1',
    });
});
