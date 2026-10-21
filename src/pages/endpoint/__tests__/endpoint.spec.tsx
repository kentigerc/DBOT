import { render, screen } from '@testing-library/react';
import { deriv_application } from '@/utils/site-config';
import Endpoint from '..';

describe('<Endpoint />', () => {
    afterEach(() => localStorage.clear());
    it('shows the registered NetoAcademy application and production callback', () => {
        render(<Endpoint />);
        expect(screen.getByText(deriv_application.app_id)).toBeInTheDocument();
        expect(screen.getByText('https://netoacademy.com/callback')).toBeInTheDocument();
    });
    it('does not let old browser endpoint overrides replace the server registration', () => {
        localStorage.setItem('config.app_id', '65555');
        localStorage.setItem('config.server_url', 'other.example');
        render(<Endpoint />);
        expect(screen.getByText(deriv_application.app_id)).toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.queryByText('other.example')).not.toBeInTheDocument();
    });
});
