import { deriv_application } from '@/utils/site-config';
import './endpoint.scss';

// The legacy editable endpoint form could not configure the new server OAuth flow.
const Endpoint = () => (
    <main className='endpoint'>
        <h1>Deriv connection</h1>
        <dl>
            <dt>Application ID</dt>
            <dd>{deriv_application.app_id}</dd>
            <dt>Registered callback</dt>
            <dd>{deriv_application.redirect_uri}</dd>
        </dl>
        <p>
            <a href='/'>Return to NetoAcademy</a>
        </p>
    </main>
);
export default Endpoint;
