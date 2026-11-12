import { useEffect, useRef, useState } from 'react';
import { sameSettings, type Settings } from '@/services/digit-strategy/strategy';
import type { Snapshot } from '@/services/digit-strategy/engine';

export default function useStrategyDraft(
    state: Pick<Snapshot, 'accountId' | 'settings' | 'active' | 'pending' | 'trades'>,
    initial: () => Settings,
    own = true
) {
    const [draft, setDraft] = useState(initial);
    const synced = useRef<{ accountId: string; settings: Settings }>();
    useEffect(() => {
        if (!state.accountId && !state.active && !state.pending && !state.trades.length) {
            synced.current = undefined;
            return;
        }
        const changed =
            !synced.current ||
            synced.current.accountId !== state.accountId ||
            !sameSettings(synced.current.settings, state.settings);
        // Polling often supplies a new object containing the same values. Keep
        // stopped local edits, while reflecting actual settings of a live run.
        if (own && (state.active || state.pending || changed)) setDraft({ ...state.settings });
        synced.current = { accountId: state.accountId, settings: state.settings };
    }, [own, state.accountId, state.settings, state.active, state.pending, state.trades.length]);
    return [draft, setDraft] as const;
}
