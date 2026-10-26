import { useStore } from '@/hooks/useStore';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { act, fireEvent, render, screen } from '@testing-library/react';
import TradeAnimation from '../trade-animation';
jest.mock('@/hooks/useStore', () => ({ useStore: jest.fn() }));
jest.mock('@/hooks/useApiBase', () => ({ useApiBase: () => ({ isAuthorizing: false, isAuthorized: false }) }));
jest.mock('@deriv-com/ui', () => ({ useDevice: () => ({ isMobile: false }) }));
jest.mock('@deriv-com/translations', () => ({
    localize: (value: string) => value,
    Localize: ({ i18n_default_text }: { i18n_default_text: string }) => <>{i18n_default_text}</>,
}));
jest.mock('@/components/contract-result-overlay', () => () => null);
jest.mock('../../../analytics/rudderstack-common-events', () => ({ rudderStackSendRunBotEvent: jest.fn() }));
jest.mock(
    '../../shared_ui/button',
    () =>
        function MockButton({
            children,
            onClick,
            id,
            is_disabled,
        }: {
            children: React.ReactNode;
            onClick: () => void;
            id: string;
            is_disabled: boolean;
        }) {
            return (
                <button id={id} onClick={onClick} disabled={is_disabled}>
                    {children}
                </button>
            );
        }
);
jest.mock('../../shared_ui/tooltip/tooltip', () => () => null);
afterEach(() => xmlScannerCycle.stop());
it('uses the existing Stop button to cancel Auto even while the Builder runner is idle', () => {
    const stop = jest.fn(() => xmlScannerCycle.stop()),
        run = jest.fn();
    (useStore as jest.Mock).mockReturnValue({
        dashboard: { active_tab: 1 },
        run_panel: {
            contract_stage: 0,
            is_stop_button_visible: false,
            is_stop_button_disabled: true,
            onRunButtonClick: run,
            onStopBotClick: stop,
            performSelfExclusionCheck: jest.fn(),
        },
        summary_card: { is_contract_completed: false, profit: 0 },
        blockly_store: { has_active_bot: true, has_saved_bots: false, checkForSavedBots: jest.fn() },
        client: { account_status: {} },
        load_modal: { dashboard_strategies: [], is_delete_modal_open: false },
    });
    xmlScannerCycle.start('TEST-DEMO', 100, jest.fn());
    render(<TradeAnimation />);
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button).toBeEnabled();
    act(() => fireEvent.click(button));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(xmlScannerCycle.getSnapshot().enabled).toBe(false);
});
