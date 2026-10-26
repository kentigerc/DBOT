import { useEffect, useState } from 'react';
import { sessionRequest, startDerivLogin } from '@/utils/deriv-session';

// A single promise prevents React StrictMode from exchanging a single-use code twice.
let completion: Promise<unknown> | undefined;
const CallbackPage = () => {
    const [error, setError] = useState('');
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (!completion) {
            const body = { code: params.get('code'), state: params.get('state'), error: params.get('error') };
            // Remove the code before the rest of the app or third-party assets can see it.
            window.history.replaceState(null, '', '/callback');
            completion = sessionRequest('/api/auth/callback', body);
        }
        completion
            .then(value =>
                window.location.replace((value as { returnTo?: string })?.returnTo === '/admin' ? '/admin' : '/')
            )
            .catch(reason => setError(reason.message));
    }, []);
    return (
        <main style={{ padding: '4rem', fontSize: '1.6rem' }}>
            <h1>{error ? 'Unable to connect your account' : 'Connecting to Deriv…'}</h1>
            {error && (
                <>
                    <p role='alert'>{error}</p>
                    <button onClick={startDerivLogin}>Try login again</button>
                </>
            )}
            <p>
                <a href='/'>Return to NetoAcademy</a>
            </p>
        </main>
    );
};
export default CallbackPage;
