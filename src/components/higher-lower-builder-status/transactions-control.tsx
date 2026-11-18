import { useState, useSyncExternalStore } from 'react';
import { getDerivAccount } from '@/utils/deriv-session';
import { higherLowerBuilder } from '@/utils/higher-lower-builder';
export default function HigherLowerTransactionsControl() {
    const state = useSyncExternalStore(higherLowerBuilder.subscribe, higherLowerBuilder.getSnapshot);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    if (getDerivAccount()?.account_id !== state.accountId || (!state.pending && !state.active && !state.starting))
        return null;
    return (
        <div>
            {state.pending?.legs.some(leg => leg.status === 'unknown') && (
                <p role='status'>Purchase unconfirmed. Check Deriv Reports before restarting.</p>
            )}
            {!state.running && (state.active || state.starting) && (
                <button
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        void higherLowerBuilder
                            .stopRestored()
                            .catch(e => setError(e.message))
                            .finally(() => setBusy(false));
                    }}
                >
                    Stop hedging entries
                </button>
            )}
            {!state.running && !state.active && !state.starting && state.pending && (
                <button
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        setError('');
                        void higherLowerBuilder
                            .refresh()
                            .catch(e => setError(e.message))
                            .finally(() => setBusy(false));
                    }}
                >
                    Refresh hedging contracts
                </button>
            )}
            {error && <p role='alert'>{error}</p>}
        </div>
    );
}
