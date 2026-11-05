import { xmlStartingStake } from '../xml-starting-stake';
const number = (value: string) => ({ type: 'math_number', getFieldValue: () => value });
it('reads a literal starting stake without executing any bot code', () => {
    expect(
        xmlStartingStake({
            getAllBlocks: () => [
                {
                    type: 'trade_definition_tradeoptions',
                    getFieldValue: () => null,
                    getInputTargetBlock: () => number('0.35'),
                },
            ],
        })
    ).toBe(0.35);
});
it('resolves the initial value of a stake variable', () => {
    const variable = { type: 'variables_get', getFieldValue: () => 'stake-id' };
    expect(
        xmlStartingStake({
            getAllBlocks: () => [
                {
                    type: 'trade_definition_tradeoptions',
                    getFieldValue: () => null,
                    getInputTargetBlock: () => variable,
                },
                { type: 'variables_set', getFieldValue: () => 'stake-id', getInputTargetBlock: () => number('3') },
            ],
        })
    ).toBe(3);
});
it('leaves dynamic expressions for the exact pre-purchase balance check', () => {
    expect(
        xmlStartingStake({
            getAllBlocks: () => [
                {
                    type: 'trade_definition_tradeoptions',
                    getFieldValue: () => null,
                    getInputTargetBlock: () => ({ type: 'math_arithmetic', getFieldValue: jest.fn() }),
                },
            ],
        })
    ).toBeUndefined();
});
