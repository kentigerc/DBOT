import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { sessionRequest } from '@/utils/deriv-session';
import CallbackPage from '../callback-page';

jest.mock('@/utils/deriv-session', () => ({ sessionRequest: jest.fn(), startDerivLogin: jest.fn() }));

it('exchanges the code once, removes it from the URL, and returns ordinary login to the platform', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'location')!;
    const previousUrl = document.URL;
    const replace = jest.fn();
    window.history.replaceState(null, '', '/callback?code=test-code&state=test-state');
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { search: '?code=test-code&state=test-state', replace },
    });
    // A legacy server returning '/' must not send the user back to the landing page.
    jest.mocked(sessionRequest).mockResolvedValue({ authenticated: true, returnTo: '/' });
    try {
        render(<StrictMode><CallbackPage /></StrictMode>);
        await waitFor(() => expect(replace).toHaveBeenCalledWith('/platform#bot_builder'));
        expect(sessionRequest).toHaveBeenCalledTimes(1);
        expect(sessionRequest).toHaveBeenCalledWith('/api/auth/callback', {
            code: 'test-code', state: 'test-state', error: null,
        });
        expect(document.URL).not.toContain('test-code');
        expect(document.URL).not.toContain('test-state');
    } finally {
        Object.defineProperty(window, 'location', original);
        window.history.replaceState(null, '', previousUrl);
    }
});
