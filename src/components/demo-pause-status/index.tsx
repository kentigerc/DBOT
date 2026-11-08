import type { DemoPauseView } from '@/services/digit-strategy/engine';
import './demo-pause-status.scss';

export default function DemoPauseStatus({ state }: { state?: DemoPauseView }) {
    if (!state || state.status === 'done') return null;
    return (
        <aside className='demo-pause-status' role='status' aria-live='polite'>
            <strong>DEMO PAUSE · {state.completed}/2 trades completed</strong>
            <p>Real recovery is paused. The next two completed trades use your demo account; wins are not required.</p>
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
