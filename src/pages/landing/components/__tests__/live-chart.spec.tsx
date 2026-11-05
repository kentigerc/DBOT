import { act, fireEvent, render, screen } from '@testing-library/react';
import LiveChart from '../live-chart';

let mockChartProps: any;
let mockConnection: EventTarget & { readyState: number };
const mockSend = jest.fn();
const mockForget = jest.fn().mockResolvedValue({});
const mockDisconnect = jest.fn();
const mockStopKeepalive = jest.fn();
const mockUnsubscribe = jest.fn();
let mockMessage: (value: any) => void;
jest.mock('@/external/bot-skeleton/services/api/new-api-transport', () => ({
    NewApiTransport: jest.fn().mockImplementation(() => {
        mockConnection = Object.assign(new EventTarget(), { readyState: 0 });
        return mockConnection;
    }),
}));
jest.mock('@deriv/deriv-api/dist/DerivAPIBasic', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        connection: mockConnection,
        send: mockSend,
        forget: mockForget,
        disconnect: mockDisconnect,
        onMessage: () => ({
            subscribe: (callback: any) => {
                mockMessage = callback;
                return { unsubscribe: mockUnsubscribe };
            },
        }),
    })),
}));
jest.mock('@/utils/api-keepalive', () => ({ startApiKeepalive: () => mockStopKeepalive }));
jest.mock('@deriv/deriv-charts', () => ({
    SmartChart: (props: any) => {
        mockChartProps = props;
        return <div data-testid='smartchart' />;
    },
    ChartTitle: () => null,
    setSmartChartsPublicPath: jest.fn(),
}));
jest.mock('@/pages/chart/toolbar-widgets', () => () => null);
jest.mock('@deriv-com/ui', () => ({ useDevice: () => ({ isDesktop: true, isMobile: false }) }));
beforeEach(() => {
    jest.clearAllMocks();
    mockChartProps = undefined;
});
const open = () =>
    act(() => {
        mockConnection.readyState = 1;
        mockConnection.dispatchEvent(new Event('open'));
    });
it('connects to public data without an account and updates theme without replacing the connection', () => {
    const { NewApiTransport } = jest.requireMock('@/external/bot-skeleton/services/api/new-api-transport');
    const { rerender, unmount } = render(<LiveChart darkMode />);
    expect(screen.getByRole('status').textContent).toContain('Connecting');
    expect(NewApiTransport.mock.calls[0][0]).toMatch(/\/api\/socket$/);
    expect(NewApiTransport.mock.calls[0]).toHaveLength(1);
    open();
    expect(screen.getByTestId('smartchart')).toBeTruthy();
    expect(mockChartProps.settings.theme).toBe('dark');
    expect(mockChartProps.chartType).toBe('line');
    rerender(<LiveChart darkMode={false} />);
    expect(mockChartProps.settings.theme).toBe('light');
    expect(NewApiTransport).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockStopKeepalive).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
});
it('delivers only the matching price stream and unsubscribes when the chart releases it', async () => {
    render(<LiveChart darkMode />);
    open();
    const history = { subscription: { id: 'prices' }, history: { prices: [100], times: [1] } };
    mockSend.mockResolvedValueOnce(history);
    const callback = jest.fn();
    await mockChartProps.requestSubscribe({ ticks_history: 'R_100', subscribe: 1 }, callback);
    mockMessage({ data: { subscription: { id: 'another-chart' } } });
    expect(callback).toHaveBeenCalledTimes(1);
    mockMessage({ data: { subscription: { id: 'prices' }, tick: { quote: 101 } } });
    expect(callback).toHaveBeenCalledTimes(2);
    mockChartProps.requestForgetStream('prices');
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockForget).toHaveBeenCalledWith('prices');
});
it('offers reconnection when the public socket closes', () => {
    render(<LiveChart darkMode />);
    open();
    act(() => {
        mockConnection.readyState = 3;
        mockConnection.dispatchEvent(new Event('close'));
    });
    expect(screen.getByRole('alert').textContent).toContain('disconnected');
    expect(screen.queryByTestId('smartchart')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect chart' }));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    open();
    expect(screen.getByTestId('smartchart')).toBeTruthy();
});
