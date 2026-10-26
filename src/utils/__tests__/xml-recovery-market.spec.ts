import { retargetXmlRecovery } from '../xml-recovery-market';
import { waitForHostedBotReady } from '../hosted-bot-market';
jest.mock('../hosted-bot-market', () => ({ waitForHostedBotReady: jest.fn().mockResolvedValue(true) }));
const target = {
    symbol: '1HZ50V',
    submarket: 'random_index',
    side: 'over' as const,
    name: 'Over Punisher',
    sampleSize: 100,
    baselineCounts: [],
};
const setup = () => {
    const engine = {
        options: { symbol: 'R_100', amount: 1.55 },
        tradeOptions: { symbol: 'R_100', amount: 1.55, barrier: 5, duration: 2 },
        initArgs: ['session', {}, 'keep'],
        watchTicks: jest.fn().mockResolvedValue(undefined),
    };
    const market = { type: 'trade_definition_market', getFieldValue: () => 'random_index', setFieldValue: jest.fn() };
    const dependencies = {
        contracts: jest
            .fn()
            .mockResolvedValue([
                {
                    contract_type: 'DIGITUNDER',
                    expiry_type: 'tick',
                    min_contract_duration: '1t',
                    max_contract_duration: '10t',
                },
            ]),
        workspace: { getAllBlocks: () => [market] },
        valid: () => true,
    };
    return { engine, market, dependencies };
};
it('moves the existing recovery to a 1-second market without altering stake, barrier, duration or initialization arguments', async () => {
    const { engine, market, dependencies } = setup();
    expect(await retargetXmlRecovery(engine, target, 'DIGITUNDER', dependencies)).toBe(true);
    expect(engine.tradeOptions).toEqual({ symbol: '1HZ50V', amount: 1.55, barrier: 5, duration: 2 });
    expect(engine.options).toEqual({ symbol: '1HZ50V', amount: 1.55 });
    expect(engine.initArgs).toEqual(['session', engine.options, 'keep']);
    expect(engine.watchTicks).toHaveBeenCalledWith('1HZ50V');
    expect(market.setFieldValue).toHaveBeenCalledWith('1HZ50V', 'SYMBOL_LIST');
});
it('rejects a market without the XML recovery contract before changing any bindings', async () => {
    const { engine, market, dependencies } = setup();
    expect(await retargetXmlRecovery(engine, target, 'DIGITEVEN', dependencies)).toBe(false);
    expect(engine.watchTicks).not.toHaveBeenCalled();
    expect(market.setFieldValue).not.toHaveBeenCalled();
});
it('does not switch the running engine after STOP during workspace readiness', async () => {
    const { engine, dependencies } = setup();
    let valid = true;
    (waitForHostedBotReady as jest.Mock).mockImplementationOnce(async () => {
        valid = false;
        return true;
    });
    expect(await retargetXmlRecovery(engine, target, 'DIGITUNDER', { ...dependencies, valid: () => valid })).toBe(
        false
    );
    expect(engine.watchTicks).not.toHaveBeenCalled();
    expect(engine.tradeOptions.symbol).toBe('R_100');
});
