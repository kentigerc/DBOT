import type { DemoPauseView } from '@/services/digit-strategy/engine';
import './demo-pause-status.scss';

export default function DemoPauseStatus({ state }: { state?: DemoPauseView }) {
    if (!state || (state.status === 'done' && state.wins === 1)) return null;
    return (
        <aside className='demo-pause-status' role='status' aria-live='polite'>
            <strong>
                DEMO PAUSE · {state.completed} {state.completed === 1 ? 'trade' : 'trades'} completed ·{' '}
                {state.wins || 0}/1 wins
            </strong>
            <p>Real recovery is paused. Trading stays on your demo account until one demo trade wins.</p>
            <div>
                {state.demoAccountId && <span>Demo account: {state.demoAccountId}</span>}
                {state.heldStake !== undefined && (
                    <span>Held real recovery stake: ${(state.heldStake / 100).toFixed(2)}</span>
                )}
            </div>
            <small>Demo results do not change real P/L, the real loss streak or the held stake.</small>
            {state.error && <p className='demo-pause-status__error'>{state.error}</p>}
        </aside>
    );
}
