type Block = {
    type: string;
    getFieldValue: (name: string) => string | null;
    getInputTargetBlock?: (name: string) => Block | null;
};
// Inspect simple literals/initial assignments only; never evaluate user Blockly code to check funds.
export function xmlStartingStake(workspace?: { getAllBlocks: () => Block[] }) {
    const blocks = workspace?.getAllBlocks() || [];
    const options = blocks.find(block => block.type === 'trade_definition_tradeoptions');
    const amount = options?.getInputTargetBlock?.('AMOUNT');
    const numeric = (block?: Block | null) => {
        if (block?.type !== 'math_number') return undefined;
        const value = Number(block.getFieldValue('NUM'));
        return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    if (amount?.type === 'math_number') return numeric(amount);
    if (amount?.type === 'variables_get') {
        const variable = amount.getFieldValue('VAR');
        const assignment = blocks.find(
            block => block.type === 'variables_set' && block.getFieldValue('VAR') === variable
        );
        return numeric(assignment?.getInputTargetBlock?.('VALUE'));
    }
    return undefined;
}
