import Interpreter from '../interpreter';
import { api_base } from '../../../api/api-base';
import { createScope } from '../cliTools';
import Interface from '../../Interface';
import { observer } from '../../../../utils/observer';
jest.mock('@/components/shared', () => ({ isMultiplierContract: () => false }));
jest.mock('@/utils/clone', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@deriv/js-interpreter', () => ({ __esModule: true, default: class Interpreter {} }));
jest.mock('../../../../constants/messages', () => ({ unrecoverable_errors: [] }));
jest.mock('../../../../utils/observer', () => ({ observer: { getState: () => [], emit: jest.fn() } }));
jest.mock('../../../api/api-base', () => ({ api_base: { is_stopping: false, clearSubscriptions: jest.fn() } }));
jest.mock('../../Interface', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../cliTools', () => ({ createScope: jest.fn() }));
const unsubscribe = jest.fn();
beforeEach(() => {
    jest.clearAllMocks();
    api_base.is_stopping = false;
    (createScope as jest.Mock).mockReturnValue({
        observer: { register: jest.fn() },
        ticksService: { unsubscribeFromTicksService: unsubscribe },
    });
    (Interface as jest.Mock).mockReturnValue({ tradeEngine: {} });
});
it('propagates a rejected tick unsubscribe and releases the stopping flag instead of hanging forever', async () => {
    unsubscribe.mockRejectedValue(new Error('Socket closed'));
    const interpreter = Interpreter();
    await expect(interpreter.stop()).rejects.toThrow('Socket closed');
    expect(api_base.is_stopping).toBe(false);
    expect(observer.emit).toHaveBeenCalledWith('bot.stop');
});
it('keeps the stop pending until actual unsubscribe completes', async () => {
    let finish!: () => void;
    unsubscribe.mockImplementation(
        () =>
            new Promise<void>(resolve => {
                finish = resolve;
            })
    );
    const stopping = Interpreter().stop();
    expect(api_base.is_stopping).toBe(true);
    finish();
    await stopping;
    expect(api_base.is_stopping).toBe(false);
});
it('propagates direct teardown errors to callers', async () => {
    unsubscribe.mockRejectedValue(new Error('Disconnected'));
    await expect(Interpreter().terminateSession()).rejects.toThrow('Disconnected');
    await expect(Interpreter().unsubscribeFromTicksService()).rejects.toThrow('Disconnected');
});
