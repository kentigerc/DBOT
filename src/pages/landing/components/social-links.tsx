const socials = [
    { name: 'TikTok', href: 'https://www.tiktok.com/@neto.academys', icon: 'tiktok' },
    { name: 'Facebook', href: 'https://web.facebook.com/NetoAcademy/', icon: 'facebook' },
    { name: 'X', href: 'https://x.com/NetoAcademy', icon: 'x' },
    { name: 'Instagram', href: 'https://www.instagram.com/netoacademy/', icon: 'instagram' },
    { name: 'WhatsApp', href: 'https://wa.me/netoacademy', icon: 'whatsapp' },
    { name: 'Telegram', href: 'https://t.me/netoacademyfx', icon: 'telegram' },
    { name: 'YouTube', href: 'https://www.youtube.com/@netoacademy', icon: 'youtube' },
] as const;

function SocialIcon({ name }: { name: (typeof socials)[number]['icon'] }) {
    const paths = {
        tiktok: 'M16.6 2h-3.1v13.2a2.8 2.8 0 1 1-2.4-2.8V9.2a6 6 0 1 0 5.5 6V8.5a8 8 0 0 0 4.6 1.5V6.8A4.6 4.6 0 0 1 16.6 2Z',
        facebook:
            'M14 22v-9h3l.5-3H14V8.1c0-.9.3-1.6 1.7-1.6h1.9V3.8a25 25 0 0 0-2.8-.1c-2.7 0-4.5 1.6-4.5 4.6V10H7.4v3h2.9v9H14Z',
        x: 'M18.9 2H22l-6.8 7.8L23.2 22H17l-4.9-7.4L5.7 22H2.5l7.9-9L.8 2h6.3l4.5 6.7L18.9 2ZM17.9 20h1.7L6.2 4H4.4L17.9 20Z',
        telegram:
            'M21.5 3.7 18.3 20c-.2 1.1-.9 1.4-1.8.9l-4.9-3.6-2.3 2.2c-.2.3-.5.5-1 .5l.4-5 9.1-8.3c.4-.4-.1-.6-.6-.2L6 13.6l-4.7-1.5c-1-.3-1-1 .2-1.4L20 3.5c.9-.3 1.7.2 1.5.2Z',
        youtube: 'M5 5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm5 3.5v7l6-3.5-6-3.5Z',
    };
    return (
        <svg aria-hidden='true' viewBox='0 0 24 24' width='16' height='16' fill='none'>
            {name === 'instagram' ? (
                <g stroke='currentColor' strokeWidth='1.7'>
                    <rect x='3' y='3' width='18' height='18' rx='5' />
                    <circle cx='12' cy='12' r='4' />
                    <circle cx='17.5' cy='6.5' r='1' fill='currentColor' stroke='none' />
                </g>
            ) : name === 'whatsapp' ? (
                <>
                    <path
                        d='M20.6 11.6a8.6 8.6 0 0 1-12.7 7.5L3 20.5l1.4-4.7a8.6 8.6 0 1 1 16.2-4.2Z'
                        stroke='currentColor'
                        strokeWidth='1.7'
                        strokeLinejoin='round'
                    />
                    <path
                        d='M8.3 7.8c-.3-.5-.7-.4-.9-.2-.6.5-.7 1.4-.4 2.2 1 2.8 3.2 4.9 5.9 5.8.9.3 1.8.1 2.2-.6.2-.4.3-.8 0-1l-1.8-.9c-.3-.2-.5-.1-.7.2l-.7.8c-1.5-.5-2.7-1.6-3.4-3l.6-.8c.2-.3.2-.5 0-.8l-.8-1.7Z'
                        fill='currentColor'
                    />
                </>
            ) : (
                <path d={paths[name]} fill='currentColor' fillRule='evenodd' />
            )}
        </svg>
    );
}

export default function SocialLinks() {
    return (
        <section className='nl-socials' aria-labelledby='nl-socials-heading'>
            <div className='nl-socials__heading'>
                <h2 id='nl-socials-heading'>Connect with NetoAcademy</h2>
                <p>Find us on your favourite platform.</p>
            </div>
            <nav aria-label='NetoAcademy social media'>
                {socials.map(social => (
                    <a key={social.icon} href={social.href} target='_blank' rel='noopener noreferrer'>
                        <span className={`nl-socials__icon nl-socials__icon--${social.icon}`}>
                            <SocialIcon name={social.icon} />
                        </span>
                        <span>{social.name}</span>
                        <span className='nl-socials__arrow' aria-hidden='true'>
                            <svg width='14' height='14' viewBox='0 0 24 24' fill='none'>
                                <path
                                    d='M6 18 18 6M6 6h12v12'
                                    stroke='currentColor'
                                    strokeWidth='1.5'
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                />
                            </svg>
                        </span>
                    </a>
                ))}
            </nav>
        </section>
    );
}
