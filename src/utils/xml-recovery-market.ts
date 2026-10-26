import { waitForHostedBotReady } from './hosted-bot-market';
import type { XmlScannerMatch } from './xml-scanner-cycle';
type Block = {
    type: string;
    getFieldValue: (name: string) => string;
    setFieldValue: (value: string, name: string) => void;
};
type Engine = {
    options: Record<string, unknown>;
    tradeOptions: Record<string, unknown>;
    initArgs?: unknown[];
    watchTicks: (symbol: string) => Promise<void>;
    is_proposal_subscription_required?: boolean;
    makeProposals?: (options: Record<string, unknown>) => void;
    selectProposal?: (contract: string) => unknown;
};
// Change only market bindings. Never recreate the interpreter or its recovery variables.
export async function retargetXmlRecovery(
    engine: Engine,
    target: XmlScannerMatch,
    contract: string,
    {
        contracts,
        workspace,
        valid,
    }: {
        contracts: (
            symbol: string
        ) => Promise<
            {
                contract_type: string;
                expiry_type?: string;
                min_contract_duration?: string;
                max_contract_duration?: string;
            }[]
        >;
        workspace: { getAllBlocks: () => Block[] };
        valid: () => boolean;
    }
) {
    if (!/^(R_\d+|1HZ\d+V)$/.test(target.symbol) || !/^[a-z0-9_]+$/.test(target.submarket) || !valid()) return false;
    const available = await contracts(target.symbol);
    const duration = Number(engine.tradeOptions.duration);
    const ticks = (value?: string) => (/^\d+t$/.test(value || '') ? Number.parseInt(value!, 10) : NaN);
    if (
        !valid() ||
        !available.some(
            row =>
                row.contract_type === contract &&
                row.expiry_type === 'tick' &&
                duration >= ticks(row.min_contract_duration) &&
                duration <= ticks(row.max_contract_duration)
        )
    )
        return false;
    const market = workspace.getAllBlocks().find(block => block.type === 'trade_definition_market');
    if (!market) throw new Error('The running XML has no market settings.');
    if (market.getFieldValue('SUBMARKET_LIST') !== target.submarket)
        market.setFieldValue(target.submarket, 'SUBMARKET_LIST');
    market.setFieldValue(target.symbol, 'SYMBOL_LIST');
    if (!(await waitForHostedBotReady(workspace, target.symbol, valid)) || !valid()) return false;
    await engine.watchTicks(target.symbol);
    if (!valid()) return false;
    engine.options = { ...engine.options, symbol: target.symbol };
    engine.tradeOptions = { ...engine.tradeOptions, symbol: target.symbol };
    if (engine.initArgs) engine.initArgs = [engine.initArgs[0], engine.options, ...engine.initArgs.slice(2)];
    if (engine.is_proposal_subscription_required) {
        if (!engine.makeProposals || !engine.selectProposal)
            throw new Error('Unable to refresh the XML recovery quote.');
        engine.makeProposals(engine.tradeOptions);
        const deadline = Date.now() + 10000;
        while (valid()) {
            try {
                engine.selectProposal(contract);
                return true;
            } catch {
                /* Wait for the new market's quote. */
            }
            if (Date.now() >= deadline)
                throw new Error('The recovery quote could not be refreshed on the selected market.');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }
    return true;
}
