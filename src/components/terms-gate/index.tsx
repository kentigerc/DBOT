import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getDerivSession, refreshDerivSession, sessionRequest } from '@/utils/deriv-session';
import terms from '../../../config/terms.json';
import './terms.scss';

export function TermsContent() {
    return (
        <>
            <p className='neto-terms__version'>Version {terms.version}</p>
            {terms.sections.map(section => (
                <section key={section.title}>
                    <h2>{section.title}</h2>
                    <p>{section.text}</p>
                </section>
            ))}
            <p>
                <a href={terms.derivTermsUrl} target='_blank' rel='noopener noreferrer'>
                    Read Deriv’s current Terms &amp; Conditions ↗
                </a>
            </p>
        </>
    );
}
export default function TermsGate({ children }: { children: React.ReactNode }) {
    const location = useLocation();
    const [session, setSession] = useState(getDerivSession());
    const [ready, setReady] = useState(false);
    const [checked, setChecked] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const admin = location.pathname === '/admin';
    const refresh = async () => {
        try {
            await refreshDerivSession();
            setReady(true);
            setError('');
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : 'Unable to verify this login session. Reconnect and try again.'
            );
        }
    };
    useEffect(() => {
        let active = true;
        const update = () => {
            if (active) {
                setSession(getDerivSession());
                if (!getDerivSession().authenticated) setChecked(false);
            }
        };
        const resume = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        window.addEventListener('neto-session', update);
        window.addEventListener('focus', resume);
        document.addEventListener('visibilitychange', resume);
        void refresh();
        return () => {
            active = false;
            window.removeEventListener('neto-session', update);
            window.removeEventListener('focus', resume);
            document.removeEventListener('visibilitychange', resume);
        };
    }, []);
    const required =
        ready && session.authenticated && (!session.termsAccepted || session.termsVersion !== terms.version);
    useEffect(() => {
        if (!required || admin) return;
        if (dialog.current?.showModal) dialog.current.showModal();
        else dialog.current?.setAttribute('open', '');
        return () => {
            if (dialog.current?.open) dialog.current.close?.();
        };
    }, [required, admin]);
    if (admin) return <>{children}</>;
    if (!ready)
        return (
            <div className='neto-terms neto-terms--loading' role='status'>
                <p>{error || 'Checking your session…'}</p>
                {error && <button onClick={() => void refresh()}>Try again</button>}
                <a href='/'>Return to landing page</a>
            </div>
        );
    if (!required) return <>{children}</>;
    return (
        <dialog
            className='neto-terms neto-terms--dialog'
            ref={dialog}
            aria-labelledby='neto-terms-title'
            onCancel={event => event.preventDefault()}
        >
            <header>
                <span>BEFORE YOU ENTER THE WORKSPACE</span>
                <h1 id='neto-terms-title'>{terms.title}</h1>
                <p>Please read and accept these terms for this login session.</p>
            </header>
            <div className='neto-terms__body' tabIndex={0}>
                <TermsContent />
            </div>
            <footer>
                <label>
                    <input
                        type='checkbox'
                        checked={checked}
                        disabled={saving}
                        onChange={event => setChecked(event.target.checked)}
                    />
                    <span>
                        I have read and accept the NetoAcademy Terms &amp; Conditions, including the trading risk and
                        responsibility notice.
                    </span>
                </label>
                {error && <p role='alert'>{error}</p>}
                <div className='neto-terms__actions'>
                    <a href='/'>Return to landing page</a>
                    <button
                        disabled={!checked || saving}
                        onClick={async () => {
                            setSaving(true);
                            setError('');
                            try {
                                await sessionRequest('/api/auth/terms', { accepted: true, version: terms.version });
                                await refreshDerivSession();
                            } catch (reason) {
                                setError(
                                    reason instanceof Error ? reason.message : 'Unable to save acceptance. Try again.'
                                );
                            } finally {
                                setSaving(false);
                            }
                        }}
                    >
                        {saving ? 'Saving…' : 'Accept & enter workspace'}
                    </button>
                </div>
            </footer>
        </dialog>
    );
}
