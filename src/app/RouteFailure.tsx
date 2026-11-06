// Never render exception text, stack traces or provider responses in route errors.
export default function RouteFailure() {
    return (
        <main className='app-root' role='alert'>
            <h1>NetoAcademy could not load this page</h1>
            <p>Check your connection and reload. Check any open contracts before starting another bot.</p>
            <button onClick={() => window.location.reload()}>Reload page</button>
            <a href='/'>Return to homepage</a>
        </main>
    );
}
