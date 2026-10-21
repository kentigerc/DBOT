import App from './App';
// OAuth is handled by the server. Never accept bearer tokens from URL parameters.
export const AuthWrapper = () => <App />;
