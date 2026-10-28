jest.mock('@/external/bot-skeleton/scratch/shared', () => ({ getContractTypeOptions: jest.fn() }));
jest.mock('@/external/bot-skeleton/scratch/utils', () => ({
    excludeOptionFromContextMenu: jest.fn(),
    modifyContextMenu: jest.fn(),
}));
const original = (window as any).Blockly;
const generator = {
    forBlock: {} as Record<string, (block: any) => string>,
    ORDER_ATOMIC: 0,
    valueToCode: jest.fn(() => '(under4 ? 4 : nextOver)'),
};
beforeAll(() => {
    (window as any).Blockly = { Blocks: {}, JavaScript: { javascriptGenerator: generator } };
    require('@/external/bot-skeleton/scratch/blocks/Binary/Before Purchase/purchase');
});
afterAll(() => {
    (window as any).Blockly = original;
});
function block(type: string, live: boolean) {
    return {
        data: JSON.stringify({ neto_live_prediction: live }),
        getFieldValue: () => type,
        workspace: { getAllBlocks: () => [{ type: 'trade_definition_tradeoptions', getInput: () => ({}) }] },
    };
}
it('recalculates the hosted Under 4 prediction after its signal changes, rather than retaining Over 0', () => {
    const code = generator.forBlock.purchase(block('DIGITUNDER', true));
    const purchase = jest.fn();
    // Bot.start previously evaluated prediction with under4=false and nextOver=0.
    // Before Purchase then sets under4=true: the request must now carry barrier 4.
    new Function('Bot', 'under4', 'nextOver', code)({ purchase }, true, 0);
    expect(purchase).toHaveBeenCalledWith('DIGITUNDER', 4);
});
it('retains a valid Over 0 and leaves ordinary uploaded purchase blocks unchanged', () => {
    const purchase = jest.fn();
    new Function('Bot', 'under4', 'nextOver', generator.forBlock.purchase(block('DIGITOVER', true)))(
        { purchase },
        false,
        0
    );
    expect(purchase).toHaveBeenCalledWith('DIGITOVER', 0);
    expect(generator.forBlock.purchase(block('DIGITOVER', false))).toBe("Bot.purchase('DIGITOVER');\n");
});
