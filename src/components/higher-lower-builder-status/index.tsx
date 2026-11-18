import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { getDerivAccount } from '@/utils/deriv-session';
import ProgressTicks from '@/components/shared_ui/progress-slider/progress-ticks';
import { getCardLabels } from '@/components/shared';
import { higherLowerBuilder, PAIR_BLOCK } from '@/utils/higher-lower-builder';
export default function HigherLowerBuilderStatus({
    ready = true,
    children = null,
}: {
    ready?: boolean;
    children?: ReactNode;
}) {
    const state = useSyncExternalStore(higherLowerBuilder.subscribe, higherLowerBuilder.getSnapshot);
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
    if (!state.message || (!selected && !state.running && !state.pending)) return <>{children}</>;
    const legs = (state.pending || state.history?.[0])?.legs || [];
    return (
        <section className='db-summary-card' aria-label='Higher Lower Hedging tick count'>
            {legs.length ? (
                legs.map((leg, i) => (
                    <div
                        key={leg.id || i}
                        aria-label={['CALL', 'HIGHER'].includes(leg.type) ? 'Higher tick count' : 'Lower tick count'}
                    >
                        <ProgressTicks
                            current_tick={leg.currentTick ?? 0}
                            ticks_count={leg.tickCount || state.settings?.duration || 5}
                            getCardLabels={getCardLabels}
                        />
                    </div>
                ))
            ) : (
                <ProgressTicks
                    current_tick={0}
                    ticks_count={state.settings?.duration || 5}
                    getCardLabels={getCardLabels}
                />
            )}
        </section>
    );
}
