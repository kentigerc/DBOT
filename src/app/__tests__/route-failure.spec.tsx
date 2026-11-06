import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import RouteFailure from '../RouteFailure';
it('shows a safe recovery page without exposing a route exception or stack', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const Crash = () => {
        throw new Error('private-provider-token-marker');
    };
    try {
        render(
            <RouterProvider
                router={createMemoryRouter([{ path: '/', element: <Crash />, errorElement: <RouteFailure /> }])}
            />
        );
        expect(screen.getByRole('alert').textContent).not.toContain('private-provider-token-marker');
        expect(screen.getByRole('link', { name: 'Return to homepage' })).toHaveAttribute('href', '/');
    } finally {
        quiet.mockRestore();
    }
});
