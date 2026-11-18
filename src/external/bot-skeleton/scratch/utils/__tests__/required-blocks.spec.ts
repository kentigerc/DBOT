import { isAllRequiredBlocksEnabled } from '../required-blocks';
jest.mock('@deriv-com/translations', () => ({ localize: (s: string) => s }));
jest.mock('../../../utils/observer', () => ({ observer: { emit: jest.fn() } }));
const blocks = () =>
    ['trade_definition', 'before_purchase', 'purchase', 'trade_definition_tradeoptions'].map(type => ({
        type,
        disabled: false,
    }));
it('requires the normal Purchase block before a standard XML bot can run', () => {
    const all = blocks();
    expect(isAllRequiredBlocksEnabled({ getAllBlocks: () => all })).toBe(true);
    expect(isAllRequiredBlocksEnabled({ getAllBlocks: () => all.filter(b => b.type !== 'purchase') })).toBe(false);
});
it.each(['trade_definition', 'before_purchase', 'purchase', 'trade_definition_tradeoptions'])(
    'blocks disabled mandatory %s',
    type => {
        const all = blocks();
        all.find(b => b.type === type)!.disabled = true;
        expect(isAllRequiredBlocksEnabled({ getAllBlocks: () => all })).toBe(false);
    }
);
