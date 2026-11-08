import { useStore } from '@/hooks/useStore';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { manualTraderGate } from '@/utils/manual-trader-gate';
import { DBOT_TABS } from '@/constants/bot-contents';
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
afterEach(() => {
    xmlScannerCycle.stop();
    jest.restoreAllMocks();
});
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
    expect(screen.getByText('Scanning markets')).toBeTruthy();
    act(() => {
        const token = xmlScannerCycle.claim({
            symbol: 'R_100',
            side: 'over',
            name: 'Over Punisher',
            submarket: 'random_index',
            sampleSize: 100,
            baselineCounts: [9, 9, 9, 8, 10, 10, 11, 11, 11, 12],
        })!;
        xmlScannerCycle.loaded(token, { takeProfit: 1000, stopLoss: 10000 });
    });
    expect(screen.getByText('Waiting for entry')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button).toBeEnabled();
    act(() => fireEvent.click(button));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(xmlScannerCycle.getSnapshot().enabled).toBe(false);
});

function manualStore() {
    const store = {
        dashboard: { active_tab: DBOT_TABS.MANUAL_TRADER },
        run_panel: {
            contract_stage: 0,
            is_stop_button_visible: false,
            is_stop_button_disabled: false,
            onRunButtonClick: jest.fn(),
            onStopBotClick: jest.fn(),
            performSelfExclusionCheck: jest.fn(),
        },
        summary_card: { is_contract_completed: false, profit: 0 },
        blockly_store: { has_active_bot: false, has_saved_bots: false, checkForSavedBots: jest.fn() },
        client: { account_status: {} },
        load_modal: { dashboard_strategies: [], is_delete_modal_open: false },
    };
    (useStore as jest.Mock).mockReturnValue(store);
    const snapshot = {
        ...manualTraderGate.getSnapshot(),
        plan: {
            accountId: 'TEST',
            symbol: 'R_100',
            side: 'over' as const,
            fileName: 'over-1-over-0.xml',
            name: 'Over Switcher',
        },
    };
    jest.spyOn(manualTraderGate, 'getSnapshot').mockReturnValue(snapshot);
    jest.spyOn(manualTraderGate, 'isLoaded').mockReturnValue(true);
    return store;
}
it('uses the standard Run/progress bar for a loaded Manual Trader bot even when it is not a saved bot', () => {
    const store = manualStore();
    render(<TradeAnimation />);
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(store.run_panel.onRunButtonClick).toHaveBeenCalledTimes(1);
    expect(store.run_panel.onStopBotClick).not.toHaveBeenCalled();
    expect(document.querySelector('.animation__progress')).toBeTruthy();
});
it('keeps the standard Run bar disabled until the selected Manual Trader XML is loaded on this account', () => {
    const store = manualStore();
    jest.spyOn(manualTraderGate, 'isLoaded').mockReturnValue(false);
    render(<TradeAnimation />);
    const button = screen.getByRole('button', { name: 'Run' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(store.run_panel.onRunButtonClick).not.toHaveBeenCalled();
});
it('uses the standard Stop action while Manual Trader is running', () => {
    const store = manualStore();
    store.run_panel.is_stop_button_visible = true;
    render(<TradeAnimation />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(store.run_panel.onStopBotClick).toHaveBeenCalledTimes(1);
    expect(store.run_panel.onRunButtonClick).not.toHaveBeenCalled();
});
