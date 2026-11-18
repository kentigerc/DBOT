import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { getDerivAccount } from '@/utils/deriv-session';
import { legResult, pairResult, type HedgingLeg } from '@/utils/higher-lower-results';
import { higherLowerBuilder, PAIR_BLOCK } from '@/utils/higher-lower-builder';
export default function HigherLowerBuilderStatus({
    ready = true,
    children = null,
}: {
    ready?: boolean;
    children?: ReactNode;
}) {
    const state = useSyncExternalStore(higherLowerBuilder.subscribe, higherLowerBuilder.getSnapshot);
    const [error, setError] = useState('');
    const [selected, setSelected] = useState(false);
    useEffect(() => {
        const workspace = (
            window as unknown as {
                Blockly?: {
                    derivWorkspace?: {
                        getAllBlocks: () => { type: string }[];
                        addChangeListener: (fn: () => void) => void;
                        removeChangeListener: (fn: () => void) => void;
                    };
                };
            }
        ).Blockly?.derivWorkspace;
        if (!ready || !workspace) return;
        const update = () => setSelected(workspace.getAllBlocks().some(block => block.type === PAIR_BLOCK));
        update();
        workspace.addChangeListener(update);
        return () => workspace.removeChangeListener(update);
    }, [ready]);
    if (getDerivAccount()?.account_id !== state.accountId) return <>{children}</>;
    const money = (value?: number) => (value === undefined ? 'Unconfirmed' : `$${(value / 100).toFixed(2)}`);
    const legs = (values: HedgingLeg[]) =>
        values.map((leg, i) => (
            <p key={i}>
                {['CALL', 'HIGHER'].includes(leg.type) ? 'Higher +1' : 'Lower −1'} · {legResult(leg)} · Contract{' '}
                {leg.id || 'unconfirmed'}
                {' · '}Paid {money(leg.buyPrice)} · Returned {money(leg.payout)} · P/L {money(leg.profit)}
            </p>
        ));
    if (!state.message || (!selected && !state.running && !state.pending)) return <>{children}</>;
    return (
        <section aria-label='Higher Lower Hedging XML status' style={{ padding: '12px 20px', fontSize: '14px' }}>
            <p role='status'>
                {state.message} · Pairs {state.pairs} · P/L ${(state.pnl / 100).toFixed(2)}
            </p>
            {state.pending && (
                <>
                    <p>Pending pair: {state.pending.symbol}</p>
                    {legs(state.pending.legs)}
                    <button
                        disabled={state.running}
                        onClick={() => {
                            void higherLowerBuilder.refresh().catch(e => setError(e.message));
                        }}
                    >
                        Refresh XML contract status
                    </button>
                </>
            )}
            {!!state.history?.length && (
                <div aria-label='Paired contract results'>
                    {state.history.map((pair, i) => (
                        <article key={`${pair.at}-${i}`}>
                            <h3>
                                {pair.symbol} · {pairResult(pair.legs)} · Net {money(pair.profit)}
                            </h3>
                            {legs(pair.legs)}
                        </article>
                    ))}
                </div>
            )}
            {error && <p role='alert'>{error}</p>}
        </section>
    );
}
