import { useCallback, useEffect, useRef, useState } from 'react';

// Trader feedback supplied by NetoAcademy. Preserve the original wording.
const reviews = [
    {
        name: 'Brian Mwangi',
        country: 'Kenya',
        flag: 'ke',
        text: 'I work full-time, so I rarely have time to watch charts. NetoAcademy helped me automate parts of my trading and made the process much easier.',
    },
    {
        name: 'Thabo Mokoena',
        country: 'South Africa',
        flag: 'za',
        text: 'NetoAcademy made trading much less intimidating for me. The automation tools are easy to understand and save a lot of time.',
    },
    {
        name: 'David Kato',
        country: 'Uganda',
        flag: 'ug',
        text: 'I was new to online trading and NetoAcademy made the learning curve much easier. The automated features helped me gain confidence from day one.',
    },
    {
        name: 'Samuel Okafor',
        country: 'Nigeria',
        flag: 'ng',
        text: 'The automated signals gave me more confidence when entering trades. I like that everything is clearly explained and easy to follow.',
    },
    {
        name: 'Grace Wanjiku',
        country: 'Kenya',
        flag: 'ke',
        text: 'The platform is simple to use, especially for beginners. I was able to learn the basics and get started much faster than I expected.',
    },
    {
        name: 'Lerato Khumalo',
        country: 'South Africa',
        flag: 'za',
        text: 'I appreciate how user-friendly the platform is. Even without much trading experience, I was able to get started quickly.',
    },
    {
        name: 'Rajesh Patel',
        country: 'India',
        flag: 'in',
        text: 'What impressed me most was how quickly I was able to set up my account and begin exploring automated trading strategies.',
    },
    {
        name: 'Ayesha Khan',
        country: 'Pakistan',
        flag: 'pk',
        text: 'The learning resources combined with automation make this platform stand out. It feels like a useful tool for beginners.',
    },
    {
        name: 'David Kimani',
        country: 'Kenya',
        flag: 'ke',
        text: "What impressed me most was the clean interface. Everything is organized and easy to understand, even if you're new to trading.",
    },
    {
        name: 'Sipho Dlamini',
        country: 'South Africa',
        flag: 'za',
        text: 'The dashboard is clean and professional. I particularly like how easy it is to monitor automated trades.',
    },
    {
        name: 'Daniel Phiri',
        country: 'Zambia',
        flag: 'zm',
        text: "I've tried a few trading platforms before, but the simplicity of NetoAcademy is what kept me using it.",
    },
    {
        name: 'Sarah Namugga',
        country: 'Uganda',
        flag: 'ug',
        text: "What I like most is that I don't have to spend hours analyzing charts. The platform is simple, clean, and very easy to use.",
    },
    {
        name: 'Joseph Mensah',
        country: 'Ghana',
        flag: 'gh',
        text: 'Everything from registration to activating automation was very straightforward. The design is excellent.',
    },
    {
        name: 'Faith Achieng',
        country: 'Kenya',
        flag: 'ke',
        text: "I like that I don't have to be online all day. The automation tools help me stay active in the market while focusing on other responsibilities.",
    },
    {
        name: 'Zanele Ndlovu',
        country: 'South Africa',
        flag: 'za',
        text: 'As someone with a busy schedule, I found the automation features extremely useful. They help me stay active in the markets without constantly watching charts.',
    },
    {
        name: 'Kevin Otieno',
        country: 'Kenya',
        flag: 'ke',
        text: 'The registration process was straightforward, and setting up automated trades was easier than I thought it would be.',
    },
    {
        name: 'Kagiso Molefe',
        country: 'South Africa',
        flag: 'za',
        text: 'The platform combines simplicity and functionality very well. Everything feels intuitive from the moment you log in.',
    },
    {
        name: 'Michael Ssenyonjo',
        country: 'Uganda',
        flag: 'ug',
        text: 'The automation tools are impressive and straightforward. Even with limited trading knowledge, I was able to get started quickly.',
    },
    {
        name: 'Mercy Atieno',
        country: 'Kenya',
        flag: 'ke',
        text: 'NetoAcademy combines learning and automation in a way that feels practical. It helped me gain confidence as a beginner.',
    },
    {
        name: 'Nomsa Mthembu',
        country: 'South Africa',
        flag: 'za',
        text: 'I was looking for a way to participate in trading without spending hours learning technical analysis. NetoAcademy helped simplify the process.',
    },
    {
        name: 'Chiamaka Nwosu',
        country: 'Nigeria',
        flag: 'ng',
        text: "I work full-time, so monitoring the markets constantly isn't possible for me. NetoAcademy helped bridge that gap with its automation features.",
    },
    {
        name: 'Joseph Mwangi',
        country: 'Kenya',
        flag: 'ke',
        text: "I've tried a few platforms before, but this one stands out because of how beginner-friendly it is.",
    },
    {
        name: 'Sibusiso Nkosi',
        country: 'South Africa',
        flag: 'za',
        text: 'The setup process was straightforward and the automated strategies were easy to configure. Great experience overall.',
    },
    {
        name: 'Esther Nansubuga',
        country: 'Uganda',
        flag: 'ug',
        text: "NetoAcademy combines education and automation in a way that's easy to understand. The interface feels modern and professional.",
    },
    {
        name: 'Priya Sharma',
        country: 'India',
        flag: 'in',
        text: 'The system helped reduce the stress of constantly watching price movements. Everything feels organized and user-friendly.',
    },
    {
        name: 'Hassan Raza',
        country: 'Pakistan',
        flag: 'pk',
        text: 'I liked how transparent the platform is. The setup process was smooth, and the automated features were simple to configure.',
    },
    {
        name: 'Sharon Njeri',
        country: 'Kenya',
        flag: 'ke',
        text: 'The dashboard provides a clear overview of everything. I never felt overwhelmed while learning how the platform works.',
    },
    {
        name: 'Ayanda Zulu',
        country: 'South Africa',
        flag: 'za',
        text: 'What impressed me most was how organized everything is. The platform provides a smooth experience for beginners.',
    },
    {
        name: 'Ruth Banda',
        country: 'Zambia',
        flag: 'zm',
        text: 'The platform looks professional and makes complex trading concepts easier to understand.',
    },
    {
        name: 'Abena Owusu',
        country: 'Ghana',
        flag: 'gh',
        text: 'The platform saves time and makes the trading process much easier for someone who is still learning.',
    },
    {
        name: 'Dennis Kiprotich',
        country: 'Kenya',
        flag: 'ke',
        text: "I appreciate how much time the automation features save. It's a great option for people who can't monitor the market throughout the day.",
    },
    {
        name: 'Themba Maseko',
        country: 'South Africa',
        flag: 'za',
        text: 'NetoAcademy offers a great balance between educational content and automation. It helped me build confidence as a trader.',
    },
    {
        name: 'Brian Mugisha',
        country: 'Uganda',
        flag: 'ug',
        text: 'As someone with a busy work schedule, I appreciate how the platform simplifies the trading process while still giving me control over my settings.',
    },
    {
        name: 'Lucy Wambui',
        country: 'Kenya',
        flag: 'ke',
        text: 'The platform feels modern and professional. The automated trading options are easy to configure and understand.',
    },
    {
        name: 'Naledi Seabi',
        country: 'South Africa',
        flag: 'za',
        text: 'The platform feels modern, responsive, and easy to navigate. I would definitely recommend it to anyone interested in automated trading.',
    },
];

export default function TraderReviews() {
    const section = useRef<HTMLElement>(null);
    const track = useRef<HTMLUListElement>(null);
    const quietUntil = useRef(0);
    const [autoPlay, setAutoPlay] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [visible, setVisible] = useState(true);
    const [edges, setEdges] = useState({ start: true, end: false });
    const updateEdges = useCallback(() => {
        const element = track.current;
        if (element)
            setEdges(previous => {
                const start = element.scrollLeft <= 1;
                const end = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
                return previous.start === start && previous.end === end ? previous : { start, end };
            });
    }, []);
    useEffect(() => {
        updateEdges();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateEdges) : undefined;
        if (track.current) observer?.observe(track.current);
        return () => observer?.disconnect();
    }, [updateEdges]);
    useEffect(() => {
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const change = () => setAutoPlay(!preference.matches);
        if (preference.addEventListener) preference.addEventListener('change', change);
        else preference.addListener(change);
        const observer =
            typeof IntersectionObserver !== 'undefined'
                ? new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
                : undefined;
        if (section.current) observer?.observe(section.current);
        return () => {
            if (preference.removeEventListener) preference.removeEventListener('change', change);
            else preference.removeListener(change);
            observer?.disconnect();
        };
    }, []);
    // Give swipes, wheel scrolling and keyboard navigation time to finish before advancing again.
    const interact = () => {
        quietUntil.current = Date.now() + 6000;
    };
    useEffect(() => {
        if (!autoPlay || hovered || focused || !visible) return;
        const timer = window.setInterval(() => {
            const element = track.current;
            if (!element || document.hidden || Date.now() < quietUntil.current) return;
            const end = element.scrollWidth - element.clientWidth;
            if (end <= 1) return;
            const wrap = element.scrollLeft >= end - 1;
            const card = element.firstElementChild as HTMLElement | null;
            element.scrollTo({
                left: wrap ? 0 : Math.min(end, element.scrollLeft + (card?.offsetWidth || element.clientWidth) + 20),
                behavior: wrap || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            });
        }, 2000);
        return () => window.clearInterval(timer);
    }, [autoPlay, hovered, focused, visible]);
    const scroll = (direction: number) => {
        interact();
        const element = track.current;
        if (!element) return;
        const card = element.firstElementChild as HTMLElement | null;
        element.scrollBy({
            left: direction * ((card?.offsetWidth || element.clientWidth) + 20),
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
    };
    return (
        <section
            className='nl-reviews nl-section'
            id='reviews'
            ref={section}
            aria-labelledby='nl-reviews-heading'
            onPointerEnter={event => {
                if (event.pointerType === 'mouse') setHovered(true);
            }}
            onPointerLeave={event => {
                if (event.pointerType === 'mouse') setHovered(false);
            }}
            onFocusCapture={event => setFocused(event.target.matches(':focus-visible'))}
            onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
            }}
            onPointerDownCapture={interact}
            onPointerUpCapture={interact}
            onTouchEndCapture={interact}
            onWheelCapture={interact}
            onKeyDownCapture={() => {
                setFocused(true);
                interact();
            }}
        >
            <div className='nl-reviews__heading'>
                <div>
                    <p className='nl-eyebrow'>FROM THE COMMUNITY</p>
                    <h2 id='nl-reviews-heading'>In our traders’ words.</h2>
                    <p className='nl-reviews__intro'>Experiences from people using NetoAcademy.</p>
                </div>
                <div className='nl-reviews__controls'>
                    <button
                        type='button'
                        className='nl-reviews__play'
                        aria-label={autoPlay ? 'Pause automatic reviews' : 'Play automatic reviews'}
                        aria-controls='nl-reviews-track'
                        onClick={() => setAutoPlay(value => !value)}
                    >
                        {autoPlay ? 'Pause' : 'Play'}
                    </button>
                    <button
                        type='button'
                        aria-label='Previous reviews'
                        aria-controls='nl-reviews-track'
                        disabled={edges.start}
                        onClick={() => scroll(-1)}
                    >
                        <span aria-hidden='true'>←</span>
                    </button>
                    <button
                        type='button'
                        aria-label='Next reviews'
                        aria-controls='nl-reviews-track'
                        disabled={edges.end}
                        onClick={() => scroll(1)}
                    >
                        <span aria-hidden='true'>→</span>
                    </button>
                </div>
            </div>
            <p className='nl-reviews__hint' id='nl-reviews-hint'>
                {autoPlay ? 'Reviews advance automatically. Hover or focus to pause. ' : ''}
                Swipe, scroll sideways or use the arrows to read more.
            </p>
            <ul
                className='nl-reviews__track'
                id='nl-reviews-track'
                ref={track}
                tabIndex={0}
                aria-label='Trader reviews'
                aria-describedby='nl-reviews-hint'
                onScroll={updateEdges}
            >
                {reviews.map(review => (
                    <li className='nl-reviews__card' key={review.name}>
                        <figure>
                            <span className='nl-reviews__quote' aria-hidden='true'>
                                “
                            </span>
                            <blockquote>
                                <p>{review.text}</p>
                            </blockquote>
                            <figcaption>
                                <span className='nl-reviews__avatar' aria-hidden='true'>
                                    {review.name
                                        .split(' ')
                                        .map(part => part[0])
                                        .join('')}
                                </span>
                                <div>
                                    <cite>{review.name}</cite>
                                    <span className='nl-reviews__country'>
                                        <img
                                            src={`/assets/flags/${review.flag}.svg`}
                                            width='24'
                                            height='18'
                                            alt=''
                                            loading='lazy'
                                        />
                                        {review.country}
                                    </span>
                                </div>
                            </figcaption>
                        </figure>
                    </li>
                ))}
            </ul>
        </section>
    );
}
