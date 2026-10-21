import { Link } from 'react-router-dom';
import { site_name } from '@/utils/site-config';
import './app-logo.scss';

export const AppLogo = () => {
    return (
        <div className='app-header__branding'>
            <span className='app-header__powered-by'>
                <span>Powered by</span>
                <span className='app-header__provider'>
                    <img src='/deriv-logo.svg' width='14' height='14' alt='' />
                    Deriv
                </span>
            </span>
            <Link className='app-header__logo' to='/' aria-label={`${site_name} home`}>
                {site_name}
            </Link>
        </div>
    );
};
