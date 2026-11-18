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
it('lists one Higher Lower Hedging XML bot and loads it into the existing Bot Builder', () => {
    render(<FreeBots />);
    const cards = screen.getAllByRole('heading', { name: 'Higher Lower Hedging' });
    expect(cards).toHaveLength(1);
    expect(screen.queryByText(/paired-order runner/)).toBeNull();
    fireEvent.click(
        within(cards[0].closest('.free-bots__card') as HTMLElement).getByRole('button', { name: 'Load Bot' })
    );
    expect(mockNavigate).toHaveBeenCalledWith('/platform#bot_builder');
    expect(mockSetActiveTab).toHaveBeenCalledWith(1);
    expect(JSON.parse(sessionStorage.getItem('neto.pendingBot') || '{}')).toEqual({
        fileName: 'higher-lower-pair.xml',
        name: 'Higher Lower Hedging',
    });
});
