import { render, screen } from '@testing-library/react';
import DemoPauseStatus from './index';

it('shows actual demo progress and the held real stake without presenting demo results as real P/L', () => {
    render(
        <DemoPauseStatus
            state={{
                triggerContractId: 123,
                status: 'running',
                completed: 1,
                demoAccountId: 'DOT100',
                heldStake: 1375,
            }}
        />
    );
    expect(screen.getByRole('status')).toHaveTextContent('1/2 trades completed');
    expect(screen.getByText('Demo account: DOT100')).toBeInTheDocument();
    expect(screen.getByText('Held real recovery stake: $13.75')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('wins are not required');
});
it('shows a blocked pause and removes the banner after two completed demo trades', () => {
    const state = { triggerContractId: 123, status: 'blocked', completed: 1, error: 'Demo account unavailable' };
    const { rerender } = render(<DemoPauseStatus state={state} />);
    expect(screen.getByText('Demo account unavailable')).toBeInTheDocument();
    rerender(<DemoPauseStatus state={{ ...state, completed: 2, status: 'done' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
